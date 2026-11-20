//! Sends the core's `tracing` events (info and above) to logcat under the tag `MaglevCore`.
//!
//! No new crate: the core already depends on `tracing`, and a `tracing::Subscriber` is a small trait. On Android the
//! text goes through `__android_log_write` (liblog, always present, declared by hand). On other hosts the writer
//! does nothing, so the pure formatting below is unit tested anywhere. Contract section 41, "Debug log".
//! API: https://docs.rs/tracing-core/0.1.36/tracing_core/subscriber/trait.Subscriber.html

use std::fmt::{self, Debug, Write as _};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};

/// logcat tag.
pub const TAG: &str = "MaglevCore";

const PRIO_INFO: i32 = 4;
const PRIO_WARN: i32 = 5;
const PRIO_ERROR: i32 = 6;

/// Android log priority for a tracing level (debug and trace never get here, see `enabled`).
pub fn priority(level: &Level) -> i32 {
    if *level == Level::ERROR {
        PRIO_ERROR
    } else if *level == Level::WARN {
        PRIO_WARN
    } else {
        PRIO_INFO
    }
}

/// Collects the `message` field first and every other field as `name=value`.
#[derive(Default)]
struct LineVisitor {
    message: String,
    fields: String,
}

impl Visit for LineVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{:?}", value);
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            let _ = write!(self.fields, "{}={:?}", field.name(), value);
        }
    }
}

/// `target: message name=value ...`
pub fn format_line(target: &str, message: &str, fields: &str) -> String {
    let mut out = String::with_capacity(target.len() + message.len() + fields.len() + 4);
    out.push_str(target);
    out.push_str(": ");
    out.push_str(message);
    if !fields.is_empty() {
        if !message.is_empty() {
            out.push(' ');
        }
        out.push_str(fields);
    }
    out
}

#[cfg(target_os = "android")]
fn write_logcat(prio: i32, text: &str) {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};

    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }
    // Interior NULs would make CString::new fail; drop them.
    let tag = CString::new(TAG).unwrap_or_default();
    let body = CString::new(text.replace('\0', "")).unwrap_or_default();
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    unsafe {
        __android_log_write(prio as c_int, tag.as_ptr(), body.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
fn write_logcat(_prio: i32, _text: &str) {}

struct LogcatSubscriber {
    next_id: AtomicU64,
}

impl Subscriber for LogcatSubscriber {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        // In tracing, "less verbose" compares as smaller: ERROR <= WARN <= INFO.
        *metadata.level() <= Level::INFO
    }

    fn new_span(&self, _span: &Attributes<'_>) -> Id {
        Id::from_u64(self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}

    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut v = LineVisitor::default();
        event.record(&mut v);
        let meta = event.metadata();
        write_logcat(priority(meta.level()), &format_line(meta.target(), &v.message, &v.fields));
    }

    fn enter(&self, _span: &Id) {}

    fn exit(&self, _span: &Id) {}
}

impl Debug for LogcatSubscriber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LogcatSubscriber")
    }
}

static INIT: Once = Once::new();

/// Installs the logcat subscriber once per process. A second call, or another global subscriber, is ignored.
pub fn init() {
    INIT.call_once(|| {
        let _ = tracing::subscriber::set_global_default(LogcatSubscriber { next_id: AtomicU64::new(1) });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priorities_map_to_android_levels() {
        assert_eq!(priority(&Level::ERROR), 6);
        assert_eq!(priority(&Level::WARN), 5);
        assert_eq!(priority(&Level::INFO), 4);
    }

    #[test]
    fn line_has_target_message_and_fields() {
        assert_eq!(format_line("maglev_core::engine", "started", "port=6881"), "maglev_core::engine: started port=6881");
        assert_eq!(format_line("t", "", "a=1"), "t: a=1");
        assert_eq!(format_line("t", "m", ""), "t: m");
    }

    #[test]
    fn init_twice_is_harmless() {
        init();
        init();
    }
}
