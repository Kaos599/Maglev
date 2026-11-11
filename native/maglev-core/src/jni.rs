//! JNI exports for `com.maglev.engine.NativeCore`.
//!
//! Every export is a thin wrapper: read the arguments, run the engine call inside `catch_unwind`,
//! and return a JSON `Result` envelope string. Nothing here throws a Java exception.
//! The Kotlin externs are `@JvmStatic`, so each function receives a `JClass`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use jni::objects::{JByteBuffer, JClass, JString};
use jni::sys::{jboolean, jint, jlong, jstring};
use jni::JNIEnv;
use parking_lot::Mutex;

use crate::engine::MaglevEngine;
use crate::error::{ok_empty, ok_envelope, panic_envelope, result_envelope, EngineError};
use crate::simd::MATRIX_SIZE;

static ENGINE: Mutex<Option<Arc<MaglevEngine>>> = Mutex::new(None);
static INIT_LOCK: Mutex<()> = Mutex::new(());

fn guarded(f: impl FnOnce() -> String) -> String {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| panic_envelope())
}

fn with_engine(f: impl FnOnce(&Arc<MaglevEngine>) -> String) -> String {
    // Clone the Arc out so the global lock is not held while the call blocks.
    let engine = ENGINE.lock().clone();
    match engine {
        Some(e) => f(&e),
        None => EngineError::not_initialized().to_json(),
    }
}

fn read_str(env: &mut JNIEnv, s: &JString) -> Option<String> {
    env.get_string(s).ok().map(String::from)
}

fn bad_argument() -> String {
    EngineError::internal("The app sent the engine something it couldn't read").to_json()
}

fn reply(env: &mut JNIEnv, out: &str) -> jstring {
    match env.new_string(out) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeInit(
    mut env: JNIEnv,
    _class: JClass,
    config_json: JString,
    session_dir: JString,
    default_download_dir: JString,
) -> jstring {
    let args = (
        read_str(&mut env, &config_json),
        read_str(&mut env, &session_dir),
        read_str(&mut env, &default_download_dir),
    );
    let out = match args {
        (Some(cfg), Some(dir), Some(dl)) => guarded(|| {
            let _init = INIT_LOCK.lock();
            if let Some(existing) = ENGINE.lock().clone() {
                return ok_envelope(&existing.init_result());
            }
            match MaglevEngine::new(&cfg, &dir, &dl) {
                Ok(engine) => {
                    let r = ok_envelope(&engine.init_result());
                    *ENGINE.lock() = Some(engine);
                    r
                }
                Err(e) => e.to_json(),
            }
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeShutdown(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let out = guarded(|| {
        let _init = INIT_LOCK.lock();
        let engine = ENGINE.lock().take();
        match engine {
            Some(e) => result_envelope(e.shutdown()),
            None => ok_empty(),
        }
    });
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeResolveMetadata(
    mut env: JNIEnv,
    _class: JClass,
    source: JString,
    timeout_ms: jlong,
) -> jstring {
    let out = match read_str(&mut env, &source) {
        Some(s) => guarded(|| {
            with_engine(|e| result_envelope(e.resolve_metadata(&s, timeout_ms as i64)))
        }),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeResolveActivity(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
) -> jstring {
    let out = match read_str(&mut env, &info_hash) {
        Some(h) => guarded(|| with_engine(|e| result_envelope(e.resolve_activity(&h)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeCancelResolve(
    mut env: JNIEnv,
    _class: JClass,
    info_hash: JString,
) -> jstring {
    let out = match read_str(&mut env, &info_hash) {
        Some(h) => guarded(|| {
            with_engine(|e| match e.cancel_resolve(&h) {
                Ok(()) => ok_empty(),
                Err(err) => err.to_json(),
            })
        }),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeAddTorrent(
    mut env: JNIEnv,
    _class: JClass,
    source: JString,
    options_json: JString,
) -> jstring {
    let out = match (read_str(&mut env, &source), read_str(&mut env, &options_json)) {
        (Some(s), Some(o)) => guarded(|| with_engine(|e| result_envelope(e.add_torrent(&s, &o)))),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeListTorrents(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let out = guarded(|| with_engine(|e| result_envelope(e.list())));
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeGetDetail(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| with_engine(|e| result_envelope(e.detail(&id)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativePause(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| with_engine(|e| result_envelope(e.pause(&id)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeResume(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| with_engine(|e| result_envelope(e.resume(&id)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeRecheck(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| with_engine(|e| result_envelope(e.recheck(&id)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeDelete(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    delete_files: jboolean,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| {
            with_engine(|e| result_envelope(e.delete(&id, delete_files != 0)))
        }),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeSetIncludedFiles(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    indices_json: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &indices_json)) {
        (Some(id), Some(ix)) => guarded(|| {
            with_engine(|e| result_envelope(e.set_included_files(&id, &ix)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeSetFilePriorities(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    priorities_json: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &priorities_json)) {
        (Some(id), Some(json)) => guarded(|| {
            with_engine(|e| result_envelope(e.set_file_priorities(&id, &json)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeRemoveFiles(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    indices_json: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &indices_json)) {
        (Some(id), Some(ix)) => guarded(|| {
            with_engine(|e| result_envelope(e.remove_files(&id, &ix)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeSetTorrentLimits(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    limits_json: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &limits_json)) {
        (Some(id), Some(json)) => guarded(|| {
            with_engine(|e| result_envelope(e.set_torrent_limits(&id, &json)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeMoveStorage(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    dest_dir: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &dest_dir)) {
        (Some(id), Some(dest)) => guarded(|| {
            with_engine(|e| result_envelope(e.move_storage(&id, &dest)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeReannounce(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| with_engine(|e| result_envelope(e.reannounce(&id)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeAddTrackers(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    urls_json: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &urls_json)) {
        (Some(id), Some(urls)) => guarded(|| {
            with_engine(|e| result_envelope(e.add_trackers(&id, &urls)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeRemoveTracker(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    url: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &url)) {
        (Some(id), Some(url)) => guarded(|| {
            with_engine(|e| result_envelope(e.remove_tracker(&id, &url)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeExportTorrent(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    dest_path: JString,
) -> jstring {
    let out = match (read_str(&mut env, &id), read_str(&mut env, &dest_path)) {
        (Some(id), Some(dest)) => guarded(|| {
            with_engine(|e| result_envelope(e.export_torrent(&id, &dest)))
        }),
        _ => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeSetGlobalLimits(
    mut env: JNIEnv,
    _class: JClass,
    down_bps: jlong,
    up_bps: jlong,
) -> jstring {
    let out = guarded(|| {
        with_engine(|e| result_envelope(e.set_global_limits(down_bps as i64, up_bps as i64)))
    });
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeApplyConfig(
    mut env: JNIEnv,
    _class: JClass,
    config_json: JString,
) -> jstring {
    let out = match read_str(&mut env, &config_json) {
        Some(c) => guarded(|| with_engine(|e| result_envelope(e.apply_config(&c)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeGetEffectiveConfig(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let out = guarded(|| with_engine(|e| ok_envelope(&e.effective_config())));
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeSetTransfersAllowed(
    mut env: JNIEnv,
    _class: JClass,
    allowed: jboolean,
    reason: JString,
) -> jstring {
    let out = match read_str(&mut env, &reason) {
        Some(r) => guarded(|| {
            with_engine(|e| result_envelope(e.set_transfers_allowed(allowed != 0, &r)))
        }),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeGetPieceBitfield(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    out: JByteBuffer,
) -> jint {
    let id = match read_str(&mut env, &id) {
        Some(id) => id,
        None => return 0,
    };
    let addr = match env.get_direct_buffer_address(&out) {
        Ok(a) if !a.is_null() => a,
        _ => return 0,
    };
    match env.get_direct_buffer_capacity(&out) {
        Ok(cap) if cap >= MATRIX_SIZE => {}
        _ => return 0,
    }
    let written = catch_unwind(AssertUnwindSafe(|| {
        let engine = ENGINE.lock().clone();
        let engine = match engine {
            Some(e) => e,
            None => return 0,
        };
        let mut grid = [0u8; MATRIX_SIZE];
        if !engine.piece_bitfield(&id, &mut grid) {
            return 0;
        }
        // SAFETY: `addr` points at a direct ByteBuffer whose capacity was checked to be at least
        // MATRIX_SIZE bytes, and the buffer stays alive for the duration of this call.
        unsafe { std::ptr::copy_nonoverlapping(grid.as_ptr(), addr, MATRIX_SIZE) };
        MATRIX_SIZE as jint
    }));
    written.unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeStreamUrl(
    mut env: JNIEnv,
    _class: JClass,
    id: JString,
    file_index: jint,
) -> jstring {
    let out = match read_str(&mut env, &id) {
        Some(id) => guarded(|| with_engine(|e| result_envelope(e.stream_url(&id, file_index)))),
        None => bad_argument(),
    };
    reply(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeVersion(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let out = guarded(MaglevEngine::version);
    reply(&mut env, &out)
}
