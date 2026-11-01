//! JNI bridge for Maglev Android Native Module.
//!
//! Provides thread-safe communication between Kotlin and the native Rust engine.
//! Dispatches 500ms telemetry batches via a dedicated daemon dispatcher thread
//! attached via `AttachCurrentThreadAsDaemon` to prevent Tokio thread panics.
//! Exposes Phase 2 governance controls (rate limits, network, power, IP filtering).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use jni::objects::{JClass, JObject, JString};
use jni::sys::{jboolean, jint, jlong, jobject, jstring};
use jni::{JNIEnv, JavaVM};
use parking_lot::Mutex;
use tokio::sync::mpsc;

use crate::engine::{AggregatedTelemetry, MaglevEngine};
use crate::governance::{NetworkGovernance, PowerGovernance};
use crate::simd::MATRIX_SIZE;

static ENGINE: Mutex<Option<Arc<MaglevEngine>>> = Mutex::new(None);
static PIECE_BUFFERS: Mutex<Option<Box<[u8; MATRIX_SIZE]>>> = Mutex::new(None);
static DISPATCHER_RUNNING: AtomicBool = AtomicBool::new(false);

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeInit(
    mut env: JNIEnv,
    _class: JClass,
    storage_dir: JString,
    listen_port: jint,
) -> jboolean {
    let dir_str: String = match env.get_string(&storage_dir) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let jvm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(_) => return 0,
    };

    let (tx, rx) = mpsc::channel::<AggregatedTelemetry>(32);

    let engine = match MaglevEngine::new(PathBuf::from(dir_str), listen_port as u16, tx) {
        Ok(e) => Arc::new(e),
        Err(err) => {
            tracing::error!("Failed to create MaglevEngine: {}", err);
            return 0;
        }
    };

    *ENGINE.lock() = Some(Arc::clone(&engine));
    *PIECE_BUFFERS.lock() = Some(Box::new([0u8; MATRIX_SIZE]));

    // Spawn dedicated JNI telemetry dispatcher thread
    start_jni_dispatcher(jvm, rx);

    1
}

fn start_jni_dispatcher(jvm: JavaVM, mut rx: mpsc::Receiver<AggregatedTelemetry>) {
    DISPATCHER_RUNNING.store(true, Ordering::SeqCst);

    thread::Builder::new()
        .name("maglev-jni-dispatcher".to_string())
        .spawn(move || {
            let mut env = match jvm.attach_current_thread_as_daemon() {
                Ok(env) => env,
                Err(e) => {
                    tracing::error!("Failed to attach JNI daemon thread: {}", e);
                    return;
                }
            };

            while DISPATCHER_RUNNING.load(Ordering::Relaxed) {
                if let Some(telemetry) = rx.blocking_recv() {
                    if let Ok(json_str) = serde_json::to_string(&telemetry) {
                        // Deliver telemetry to Kotlin callback:
                        // MaglevEngineModule.onTelemetryUpdate(jsonStr)
                        if let Ok(j_str) = env.new_string(&json_str) {
                            let class_name = "com/maglev/engine/MaglevEngineModule";
                            if let Ok(cls) = env.find_class(class_name) {
                                let _ = env.call_static_method(
                                    cls,
                                    "onTelemetryUpdate",
                                    "(Ljava/lang/String;)V",
                                    &[(&j_str).into()],
                                );
                            }
                        }
                    }
                } else {
                    break;
                }
            }
        })
        .expect("Failed to spawn JNI dispatcher thread");
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeStartTorrent(
    mut env: JNIEnv,
    _class: JClass,
    magnet_uri: JString,
    save_path: JString,
    sequential: jboolean,
) -> jstring {
    let uri: String = match env.get_string(&magnet_uri) {
        Ok(s) => s.into(),
        Err(_) => return env.new_string("").unwrap().into_raw(),
    };

    let path_str: String = match env.get_string(&save_path) {
        Ok(s) => s.into(),
        Err(_) => String::new(),
    };

    let save_path_opt = if !path_str.is_empty() {
        Some(std::path::Path::new(&path_str))
    } else {
        None
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        match engine.start_torrent(&uri, save_path_opt, sequential != 0) {
            Ok(id) => env.new_string(id).unwrap().into_raw(),
            Err(e) => {
                tracing::error!("Failed to start torrent: {}", e);
                env.new_string("").unwrap().into_raw()
            }
        }
    } else {
        env.new_string("").unwrap().into_raw()
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativePauseTorrent(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
) -> jboolean {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        if engine.pause_torrent(&hash).is_ok() { 1 } else { 0 }
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeResumeTorrent(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
) -> jboolean {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        if engine.resume_torrent(&hash).is_ok() { 1 } else { 0 }
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeDeleteTorrent(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
    delete_files: jboolean,
) -> jboolean {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        if engine.delete_torrent(&hash, delete_files != 0).is_ok() { 1 } else { 0 }
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeSetFilePriority(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
    file_index: jint,
    priority: jint,
) -> jboolean {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        if engine.set_file_priority(&hash, file_index as usize, priority as u8).is_ok() { 1 } else { 0 }
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeGetPieceBitfieldDirect(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
) -> jobject {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return JObject::null().into_raw(),
    };

    let engine_lock = ENGINE.lock();
    let mut buf_lock = PIECE_BUFFERS.lock();

    if let (Some(ref engine), Some(ref mut buf)) = (engine_lock.as_ref(), buf_lock.as_mut()) {
        if engine.get_piece_matrix(&hash, buf.as_mut()) {
            unsafe {
                let direct_buf = env.new_direct_byte_buffer(buf.as_mut_ptr(), MATRIX_SIZE);
                match direct_buf {
                    Ok(b) => return b.into_raw(),
                    Err(_) => return JObject::null().into_raw(),
                }
            }
        }
    }
    JObject::null().into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeGetTrackers(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
) -> jstring {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return env.new_string("[]").unwrap().into_raw(),
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        if let Ok(trackers) = engine.get_trackers(&hash) {
            let json = serde_json::to_string(&trackers).unwrap_or_else(|_| "[]".to_string());
            return env.new_string(json).unwrap().into_raw();
        }
    }
    env.new_string("[]").unwrap().into_raw()
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeAddTracker(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
    tracker_url: JString,
) -> jboolean {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };
    let url: String = match env.get_string(&tracker_url) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        if engine.add_tracker(&hash, &url).is_ok() { 1 } else { 0 }
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeStartHttpStream(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
    file_index: jint,
) -> jstring {
    let hash: String = match env.get_string(&info_hash) {
        Ok(s) => s.into(),
        Err(_) => return env.new_string("").unwrap().into_raw(),
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        match engine.start_http_stream(&hash, file_index as usize) {
            Ok(url) => env.new_string(url).unwrap().into_raw(),
            Err(_) => env.new_string("").unwrap().into_raw(),
        }
    } else {
        env.new_string("").unwrap().into_raw()
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeSetRateLimits(
    _env: JNIEnv,
    _class: JClass,
    down_bytes: jlong,
    up_bytes: jlong,
) {
    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        engine.set_rate_limits(down_bytes as u64, up_bytes as u64);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeUpdateNetworkGovernance(
    mut env: JNIEnv,
    _class: JClass,
    json_str: JString,
) -> jboolean {
    let json: String = match env.get_string(&json_str) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    if let Ok(gov) = serde_json::from_str::<NetworkGovernance>(&json) {
        let lock = ENGINE.lock();
        if let Some(ref engine) = *lock {
            engine.update_network_governance(gov);
            return 1;
        }
    }
    0
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeUpdatePowerGovernance(
    mut env: JNIEnv,
    _class: JClass,
    json_str: JString,
) -> jboolean {
    let json: String = match env.get_string(&json_str) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    if let Ok(gov) = serde_json::from_str::<PowerGovernance>(&json) {
        let lock = ENGINE.lock();
        if let Some(ref engine) = *lock {
            engine.update_power_governance(gov);
            return 1;
        }
    }
    0
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeLoadIpFilter(
    mut env: JNIEnv,
    _class: JClass,
    dat_content: JString,
) -> jint {
    let content: String = match env.get_string(&dat_content) {
        Ok(s) => s.into(),
        Err(_) => return 0,
    };

    let lock = ENGINE.lock();
    if let Some(ref engine) = *lock {
        let count = engine.load_ip_filter(&content);
        return count as jint;
    }
    0
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_MaglevEngineModule_nativeStopEngine(
    _env: JNIEnv,
    _class: JClass,
) {
    DISPATCHER_RUNNING.store(false, Ordering::SeqCst);
    if let Some(engine) = ENGINE.lock().take() {
        engine.stop();
    }
}
