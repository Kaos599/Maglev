//! A reader for DASH manifests (MPD), for video on demand only.
//!
//! XML comes from `roxmltree` 0.20 (docs.rs/roxmltree/0.20: `Document::parse`, `Document::{root_element,
//! descendants}`, `Node::{children, is_element, tag_name, attribute, text}`; a document with a DTD is an error, so
//! entity tricks never run).
//!
//! Refused: any `ContentProtection` (`STREAM_PROTECTED`), `type="dynamic"` (`STREAM_LIVE`), more than one `Period`,
//! no duration, anything that would need more than 20,000 segments (`STREAM_UNSUPPORTED`).
//!
//! Segments come from `SegmentTemplate` (`$Number$` or `$Time$`, with or without a `SegmentTimeline`),
//! `SegmentList`, or a plain `BaseURL` file (`SegmentBase`: the whole file is saved, so the `sidx` index is not
//! needed). `BaseURL` nests: MPD, Period, AdaptationSet, Representation.

use super::{resolve_url, MediaPlan, Segment, StreamError, MAX_SEGMENTS};

type Node<'a, 'i> = roxmltree::Node<'a, 'i>;

#[derive(Debug, Clone, PartialEq)]
pub struct Dash {
    pub duration_sec: f64,
    pub title: Option<String>,
    /// Video representations, in manifest order. Ids are `v<adaptation>.<representation>`.
    pub video: Vec<DashRep>,
    pub audio: Vec<AudioSet>,
}

/// One audio `AdaptationSet` (an id is `a<index>`).
#[derive(Debug, Clone, PartialEq)]
pub struct AudioSet {
    pub index: usize,
    pub lang: Option<String>,
    pub label: Option<String>,
    pub reps: Vec<DashRep>,
}

impl AudioSet {
    /// The representation with the highest bandwidth.
    pub fn best(&self) -> Option<&DashRep> {
        self.reps.iter().max_by_key(|r| r.bandwidth)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashRep {
    pub id: String,
    pub bandwidth: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codecs: Option<String>,
    src: SegSource,
    period_dur: f64,
}

#[derive(Debug, Clone, PartialEq)]
enum SegSource {
    Template(Tpl),
    List { init: Option<Segment>, items: Vec<Segment> },
    Single(String),
}

#[derive(Debug, Clone, PartialEq)]
struct Tpl {
    init: Option<String>,
    media: String,
    start: u64,
    timescale: f64,
    duration: Option<u64>,
    /// `(t, d, r)` of every `<S>`.
    timeline: Vec<(Option<u64>, u64, i64)>,
    rep_id: String,
    bandwidth: u64,
    base: String,
}

/// `PT1H2M3.5S` and friends, in seconds. Years and months count as 365 and 30 days.
pub fn parse_iso_duration(s: &str) -> Option<f64> {
    let s = s.trim().strip_prefix('P')?;
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, t),
        None => (s, ""),
    };
    let mut total = 0.0_f64;
    let mut num = String::new();
    for c in date.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else {
            let v: f64 = num.parse().ok()?;
            num.clear();
            total += match c {
                'Y' => v * 31_536_000.0,
                'M' => v * 2_592_000.0,
                'W' => v * 604_800.0,
                'D' => v * 86_400.0,
                _ => return None,
            };
        }
    }
    if !num.is_empty() {
        return None;
    }
    for c in time.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else {
            let v: f64 = num.parse().ok()?;
            num.clear();
            total += match c {
                'H' => v * 3600.0,
                'M' => v * 60.0,
                'S' => v,
                _ => return None,
            };
        }
    }
    if !num.is_empty() {
        return None;
    }
    Some(total)
}

fn parse_width(fmt: &str) -> Option<usize> {
    let f = fmt.strip_suffix('d')?.trim_start_matches('0');
    f.parse().ok()
}

/// Fills `$RepresentationID$`, `$Number$`, `$Time$` and `$Bandwidth$` (the numbers may carry `%05d`). `$$` is a
/// dollar sign; an identifier we don't know is left as it is.
pub fn expand_template(t: &str, rep_id: &str, bandwidth: u64, number: u64, time: u64) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('$') {
            None => {
                out.push_str(&rest[i..]);
                return out;
            }
            Some(j) => {
                let spec = &after[..j];
                if spec.is_empty() {
                    out.push('$');
                } else {
                    let (name, fmt) = match spec.split_once('%') {
                        Some((n, f)) => (n, Some(f)),
                        None => (spec, None),
                    };
                    let num = |v: u64| -> String {
                        match fmt.and_then(parse_width) {
                            Some(width) => format!("{:0>width$}", v, width = width),
                            None => v.to_string(),
                        }
                    };
                    match name {
                        "RepresentationID" => out.push_str(rep_id),
                        "Number" => out.push_str(&num(number)),
                        "Time" => out.push_str(&num(time)),
                        "Bandwidth" => out.push_str(&num(bandwidth)),
                        _ => {
                            out.push('$');
                            out.push_str(spec);
                            out.push('$');
                        }
                    }
                }
                rest = &after[j + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

/// The first `BaseURL` child, resolved against `current`. The flag says a `BaseURL` was found.
fn base_of(n: Node, current: &str) -> (String, bool) {
    match child(n, "BaseURL").and_then(|b| b.text()).map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => match resolve_url(current, t) {
            Some(u) => (u, true),
            None => (current.to_string(), false),
        },
        None => (current.to_string(), false),
    }
}

/// An attribute from the first of these nodes that has it (Representation, then AdaptationSet, then Period).
fn inherited<'a>(nodes: &[Node<'a, '_>], name: &str) -> Option<&'a str> {
    nodes.iter().find_map(|n| n.attribute(name))
}

/// `a-b` (inclusive) as `(offset, length)`.
fn parse_range(s: &str) -> Option<(u64, u64)> {
    let (a, b) = s.trim().split_once('-')?;
    let a: u64 = a.trim().parse().ok()?;
    let b: u64 = b.trim().parse().ok()?;
    if b < a {
        return None;
    }
    Some((a, b - a + 1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Video,
    Audio,
    Other,
}

fn kind_of(adapt: Node, rep: Node) -> Kind {
    let ct = adapt.attribute("contentType");
    let mime = rep.attribute("mimeType").or_else(|| adapt.attribute("mimeType"));
    let codecs = rep.attribute("codecs").or_else(|| adapt.attribute("codecs")).unwrap_or("");
    if ct == Some("video") || mime.map(|m| m.starts_with("video/")).unwrap_or(false) {
        return Kind::Video;
    }
    if ct == Some("audio") || mime.map(|m| m.starts_with("audio/")).unwrap_or(false) {
        return Kind::Audio;
    }
    if ct.is_some() || mime.is_some() {
        // Subtitles and images.
        return Kind::Other;
    }
    let c = codecs.to_ascii_lowercase();
    if ["avc", "hvc", "hev", "vp0", "vp9", "av01"].iter().any(|p| c.starts_with(p)) {
        return Kind::Video;
    }
    if ["mp4a", "ac-3", "ec-3", "opus", "flac"].iter().any(|p| c.starts_with(p)) {
        return Kind::Audio;
    }
    if rep.attribute("height").or_else(|| adapt.attribute("height")).is_some() {
        return Kind::Video;
    }
    Kind::Other
}

fn parse_u32(v: Option<&str>) -> Option<u32> {
    v.and_then(|s| s.trim().parse().ok())
}

fn template_src(
    tpls: &[Node],
    rep_id: &str,
    bandwidth: u64,
    base: &str,
) -> Result<Tpl, StreamError> {
    let first = |name: &str| tpls.iter().find_map(|t| t.attribute(name));
    let media = first("media").ok_or(StreamError::Unsupported)?.to_string();
    let timeline_node = tpls.iter().find_map(|t| child(*t, "SegmentTimeline"));
    let mut timeline = Vec::new();
    if let Some(tl) = timeline_node {
        for s in tl.children().filter(|c| c.is_element() && c.tag_name().name() == "S") {
            let d: u64 = s.attribute("d").and_then(|v| v.trim().parse().ok()).ok_or(StreamError::Unsupported)?;
            let t = s.attribute("t").and_then(|v| v.trim().parse().ok());
            let r: i64 = s.attribute("r").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
            timeline.push((t, d, r));
            if timeline.len() > MAX_SEGMENTS {
                return Err(StreamError::Unsupported);
            }
        }
    }
    Ok(Tpl {
        init: first("initialization").map(str::to_string),
        media,
        start: first("startNumber").and_then(|v| v.trim().parse().ok()).unwrap_or(1),
        timescale: first("timescale").and_then(|v| v.trim().parse::<f64>().ok()).filter(|t| *t > 0.0).unwrap_or(1.0),
        duration: first("duration").and_then(|v| v.trim().parse().ok()),
        timeline,
        rep_id: rep_id.to_string(),
        bandwidth,
        base: base.to_string(),
    })
}

fn list_src(lists: &[Node], base: &str) -> Result<SegSource, StreamError> {
    let init = match lists.iter().find_map(|l| child(*l, "Initialization")) {
        Some(i) => {
            let url = match i.attribute("sourceURL") {
                Some(u) => resolve_url(base, u).ok_or(StreamError::Unsupported)?,
                None => base.to_string(),
            };
            Some(Segment { url, range: i.attribute("range").and_then(parse_range), key: None, whole_file: false })
        }
        None => None,
    };
    let list = lists.iter().find(|l| child(**l, "SegmentURL").is_some()).ok_or(StreamError::Unsupported)?;
    let mut items = Vec::new();
    for s in list.children().filter(|c| c.is_element() && c.tag_name().name() == "SegmentURL") {
        if items.len() >= MAX_SEGMENTS {
            return Err(StreamError::Unsupported);
        }
        let url = match s.attribute("media") {
            Some(m) => resolve_url(base, m).ok_or(StreamError::Unsupported)?,
            None => base.to_string(),
        };
        items.push(Segment { url, range: s.attribute("mediaRange").and_then(parse_range), key: None, whole_file: false });
    }
    if items.is_empty() {
        return Err(StreamError::Unsupported);
    }
    Ok(SegSource::List { init, items })
}

fn build_rep(
    rep: Node,
    adapt: Node,
    period: Node,
    base: &str,
    has_base: bool,
    id: String,
    period_dur: f64,
) -> Result<DashRep, StreamError> {
    let nodes = [rep, adapt, period];
    let bandwidth: u64 = rep.attribute("bandwidth").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let rep_id = rep.attribute("id").unwrap_or("");
    let tpls: Vec<Node> = nodes.iter().filter_map(|n| child(*n, "SegmentTemplate")).collect();
    let lists: Vec<Node> = nodes.iter().filter_map(|n| child(*n, "SegmentList")).collect();
    let src = if !tpls.is_empty() {
        SegSource::Template(template_src(&tpls, rep_id, bandwidth, base)?)
    } else if !lists.is_empty() {
        list_src(&lists, base)?
    } else if has_base {
        // `SegmentBase` (with `indexRange`) or nothing: the BaseURL is one whole file.
        SegSource::Single(base.to_string())
    } else {
        return Err(StreamError::Unsupported);
    };
    Ok(DashRep {
        id,
        bandwidth,
        width: parse_u32(inherited(&nodes[..2], "width")),
        height: parse_u32(inherited(&nodes[..2], "height")),
        codecs: inherited(&nodes[..2], "codecs").map(str::to_string),
        src,
        period_dur,
    })
}

impl DashRep {
    /// The segments of this representation (`STREAM_UNSUPPORTED` when there would be too many or none).
    pub fn plan(&self) -> Result<MediaPlan, StreamError> {
        match &self.src {
            SegSource::Single(url) => Ok(MediaPlan {
                init: None,
                segments: vec![Segment { url: url.clone(), range: None, key: None, whole_file: true }],
                duration_sec: self.period_dur,
                fmp4: true,
            }),
            SegSource::List { init, items } => Ok(MediaPlan {
                init: init.clone(),
                segments: items.clone(),
                duration_sec: self.period_dur,
                fmp4: true,
            }),
            SegSource::Template(t) => {
                let url = |number: u64, time: u64| -> Result<String, StreamError> {
                    resolve_url(&t.base, &expand_template(&t.media, &t.rep_id, t.bandwidth, number, time))
                        .ok_or(StreamError::Unsupported)
                };
                let mut segments: Vec<Segment> = Vec::new();
                if !t.timeline.is_empty() {
                    let end_ticks = (self.period_dur * t.timescale) as u64;
                    let mut cursor: u64 = 0;
                    let mut number = t.start;
                    for (i, (tt, d, r)) in t.timeline.iter().enumerate() {
                        if let Some(v) = tt {
                            cursor = *v;
                        }
                        if *d == 0 {
                            return Err(StreamError::Unsupported);
                        }
                        let reps: u64 = if *r >= 0 {
                            *r as u64 + 1
                        } else {
                            // r = -1: repeat until the next `t`, or the end of the period.
                            let limit = t.timeline.get(i + 1).and_then(|n| n.0).unwrap_or(end_ticks);
                            if limit > cursor {
                                (limit - cursor + *d - 1) / *d
                            } else {
                                1
                            }
                        };
                        for _ in 0..reps {
                            if segments.len() >= MAX_SEGMENTS {
                                return Err(StreamError::Unsupported);
                            }
                            segments.push(Segment::plain(url(number, cursor)?));
                            cursor += *d;
                            number += 1;
                        }
                    }
                } else {
                    let d = t.duration.filter(|d| *d > 0).ok_or(StreamError::Unsupported)?;
                    let count = ((self.period_dur * t.timescale) / d as f64).ceil();
                    if !(count >= 1.0) || count > MAX_SEGMENTS as f64 {
                        return Err(StreamError::Unsupported);
                    }
                    for n in 0..(count as u64) {
                        segments.push(Segment::plain(url(t.start + n, n * d)?));
                    }
                }
                if segments.is_empty() {
                    return Err(StreamError::Unsupported);
                }
                let init = match &t.init {
                    Some(i) => {
                        let u = resolve_url(&t.base, &expand_template(i, &t.rep_id, t.bandwidth, 0, 0))
                            .ok_or(StreamError::Unsupported)?;
                        Some(Segment::plain(u))
                    }
                    None => None,
                };
                Ok(MediaPlan { init, segments, duration_sec: self.period_dur, fmp4: true })
            }
        }
    }
}

/// Reads an MPD. `base` is the manifest's own (final) link.
pub fn parse(text: &str, base: &str) -> Result<Dash, StreamError> {
    let doc = roxmltree::Document::parse(text).map_err(|_| StreamError::Unsupported)?;
    let root = doc.root_element();
    if root.tag_name().name() != "MPD" {
        return Err(StreamError::Unsupported);
    }
    if doc.descendants().any(|n| n.is_element() && n.tag_name().name() == "ContentProtection") {
        return Err(StreamError::Protected);
    }
    if root.attribute("type") == Some("dynamic") {
        return Err(StreamError::Live);
    }
    let periods: Vec<Node> = root.children().filter(|c| c.is_element() && c.tag_name().name() == "Period").collect();
    if periods.len() != 1 {
        return Err(StreamError::Unsupported);
    }
    let period = periods[0];
    let duration_sec = period
        .attribute("duration")
        .or_else(|| root.attribute("mediaPresentationDuration"))
        .and_then(parse_iso_duration)
        .filter(|d| *d > 0.0)
        .ok_or(StreamError::Unsupported)?;
    let title = child(root, "ProgramInformation")
        .and_then(|p| child(p, "Title"))
        .and_then(|t| t.text())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    let (mpd_base, _) = base_of(root, base);
    let (period_base, period_has) = base_of(period, &mpd_base);
    let mut video = Vec::new();
    let mut audio = Vec::new();
    let adapts = period.children().filter(|c| c.is_element() && c.tag_name().name() == "AdaptationSet");
    for (ai, adapt) in adapts.enumerate() {
        let (adapt_base, adapt_has) = base_of(adapt, &period_base);
        let mut set_reps: Vec<DashRep> = Vec::new();
        let mut set_kind = Kind::Other;
        let reps = adapt.children().filter(|c| c.is_element() && c.tag_name().name() == "Representation");
        for (ri, rep) in reps.enumerate() {
            let kind = kind_of(adapt, rep);
            if kind == Kind::Other {
                continue;
            }
            set_kind = kind;
            let (rep_base, rep_has) = base_of(rep, &adapt_base);
            let prefix = if kind == Kind::Video { "v" } else { "a" };
            let id = format!("{prefix}{ai}.{ri}");
            let r = build_rep(rep, adapt, period, &rep_base, period_has || adapt_has || rep_has, id, duration_sec)?;
            if kind == Kind::Video {
                video.push(r);
            } else {
                set_reps.push(r);
            }
        }
        if set_kind == Kind::Audio && !set_reps.is_empty() {
            audio.push(AudioSet {
                index: ai,
                lang: adapt.attribute("lang").map(str::to_string),
                label: child(adapt, "Label").and_then(|l| l.text()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
                reps: set_reps,
            });
        }
    }
    if video.is_empty() && audio.is_empty() {
        return Err(StreamError::Unsupported);
    }
    Ok(Dash { duration_sec, title, video, audio })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://cdn.test/dash/manifest.mpd";

    fn mpd(body: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" type=\"static\" \
mediaPresentationDuration=\"PT30S\">{body}</MPD>"
        )
    }

    fn urls(p: &MediaPlan) -> Vec<String> {
        p.segments.iter().map(|s| s.url.clone()).collect()
    }

    #[test]
    fn iso_durations() {
        assert_eq!(parse_iso_duration("PT30S"), Some(30.0));
        assert_eq!(parse_iso_duration("PT1H2M3.5S"), Some(3723.5));
        assert_eq!(parse_iso_duration("P1DT1H"), Some(90_000.0));
        assert_eq!(parse_iso_duration("PT10M"), Some(600.0));
        assert_eq!(parse_iso_duration("30S"), None);
        assert_eq!(parse_iso_duration("PT3"), None);
    }

    #[test]
    fn template_expansion() {
        assert_eq!(expand_template("seg-$Number$.m4s", "v1", 100, 7, 0), "seg-7.m4s");
        assert_eq!(expand_template("$RepresentationID$/$Number%05d$.m4s", "720p", 100, 42, 0), "720p/00042.m4s");
        assert_eq!(expand_template("t$Time$-$Bandwidth$", "r", 2500, 1, 90000), "t90000-2500");
        assert_eq!(expand_template("a$$b", "r", 1, 1, 1), "a$b");
        assert_eq!(expand_template("x$Unknown$y", "r", 1, 1, 1), "x$Unknown$y");
        assert_eq!(expand_template("lone$", "r", 1, 1, 1), "lone$");
    }

    #[test]
    fn number_template_with_start_number_and_duration() {
        let text = mpd(
            "<Period><AdaptationSet mimeType=\"video/mp4\" codecs=\"avc1.64001f\">\
<SegmentTemplate timescale=\"1000\" duration=\"4000\" startNumber=\"5\" initialization=\"$RepresentationID$/init.mp4\" \
media=\"$RepresentationID$/s$Number$.m4s\"/>\
<Representation id=\"hd\" bandwidth=\"2000000\" width=\"1280\" height=\"720\"/></AdaptationSet></Period>",
        );
        let d = parse(&text, BASE).unwrap();
        assert_eq!(d.video.len(), 1);
        assert_eq!(d.video[0].id, "v0.0");
        assert_eq!(d.video[0].height, Some(720));
        assert_eq!(d.video[0].codecs.as_deref(), Some("avc1.64001f"));
        let p = d.video[0].plan().unwrap();
        // 30 s / 4 s = 8 segments (the last is short), numbered from 5.
        assert_eq!(p.segments.len(), 8);
        assert_eq!(p.segments[0].url, "https://cdn.test/dash/hd/s5.m4s");
        assert_eq!(p.segments[7].url, "https://cdn.test/dash/hd/s12.m4s");
        assert_eq!(p.init.as_ref().unwrap().url, "https://cdn.test/dash/hd/init.mp4");
        assert!(p.fmp4);
        assert_eq!(p.items().len(), 9);
    }

    #[test]
    fn time_template_with_repeats_and_open_repeat() {
        let text = mpd(
            "<Period><AdaptationSet contentType=\"video\">\
<SegmentTemplate timescale=\"1000\" media=\"v-$Time$.m4s\" initialization=\"i.mp4\">\
<SegmentTimeline><S t=\"0\" d=\"4000\" r=\"2\"/><S d=\"2000\"/><S t=\"14000\" d=\"8000\" r=\"-1\"/></SegmentTimeline>\
</SegmentTemplate><Representation id=\"a\" bandwidth=\"1\" height=\"360\"/></AdaptationSet></Period>",
        );
        let p = parse(&text, BASE).unwrap().video[0].plan().unwrap();
        // 3 x 4 s, 1 x 2 s, then from 14 s to the end at 30 s in steps of 8 s: ceil(16/8) = 2.
        assert_eq!(
            urls(&p),
            vec![
                "https://cdn.test/dash/v-0.m4s",
                "https://cdn.test/dash/v-4000.m4s",
                "https://cdn.test/dash/v-8000.m4s",
                "https://cdn.test/dash/v-12000.m4s",
                "https://cdn.test/dash/v-14000.m4s",
                "https://cdn.test/dash/v-22000.m4s",
            ]
        );
    }

    #[test]
    fn timeline_numbers_continue_from_start_number() {
        let text = mpd(
            "<Period><AdaptationSet contentType=\"video\"><SegmentTemplate timescale=\"1\" startNumber=\"10\" \
media=\"s$Number$.m4s\"><SegmentTimeline><S t=\"0\" d=\"10\" r=\"1\"/></SegmentTimeline></SegmentTemplate>\
<Representation id=\"a\" bandwidth=\"1\"/></AdaptationSet></Period>",
        );
        let p = parse(&text, BASE).unwrap().video[0].plan().unwrap();
        assert_eq!(urls(&p), vec!["https://cdn.test/dash/s10.m4s", "https://cdn.test/dash/s11.m4s"]);
    }

    #[test]
    fn segment_list_with_ranges() {
        let text = mpd(
            "<Period><AdaptationSet mimeType=\"video/mp4\"><Representation id=\"a\" bandwidth=\"5\" height=\"480\">\
<SegmentList duration=\"10\"><Initialization sourceURL=\"init.mp4\" range=\"0-99\"/>\
<SegmentURL media=\"one.m4s\"/><SegmentURL media=\"big.mp4\" mediaRange=\"100-199\"/></SegmentList>\
</Representation></AdaptationSet></Period>",
        );
        let p = parse(&text, BASE).unwrap().video[0].plan().unwrap();
        assert_eq!(p.init.as_ref().unwrap().range, Some((0, 100)));
        assert_eq!(p.segments.len(), 2);
        assert_eq!(p.segments[0].url, "https://cdn.test/dash/one.m4s");
        assert_eq!(p.segments[1].range, Some((100, 100)));
    }

    #[test]
    fn base_urls_nest() {
        let text = mpd(
            "<BaseURL>https://root.test/m/</BaseURL><Period><BaseURL>p1/</BaseURL><AdaptationSet mimeType=\"video/mp4\">\
<BaseURL>a/</BaseURL><Representation id=\"r\" bandwidth=\"5\" height=\"480\"><BaseURL>rep/</BaseURL>\
<SegmentTemplate timescale=\"1\" duration=\"30\" media=\"s$Number$.m4s\"/></Representation></AdaptationSet></Period>",
        );
        let p = parse(&text, BASE).unwrap().video[0].plan().unwrap();
        assert_eq!(urls(&p), vec!["https://root.test/m/p1/a/rep/s1.m4s"]);
    }

    #[test]
    fn segment_base_with_index_range_is_one_whole_file() {
        let text = mpd(
            "<Period><AdaptationSet mimeType=\"video/mp4\"><Representation id=\"r\" bandwidth=\"5\" height=\"480\">\
<BaseURL>movie.mp4</BaseURL><SegmentBase indexRange=\"100-500\"><Initialization range=\"0-99\"/></SegmentBase>\
</Representation></AdaptationSet></Period>",
        );
        let p = parse(&text, BASE).unwrap().video[0].plan().unwrap();
        assert_eq!(p.segments.len(), 1);
        assert_eq!(p.segments[0].url, "https://cdn.test/dash/movie.mp4");
        assert!(p.segments[0].whole_file);
        assert!(p.init.is_none());
    }

    #[test]
    fn video_and_audio_sets_and_title() {
        let text = mpd(
            "<ProgramInformation><Title> My film </Title></ProgramInformation><Period>\
<AdaptationSet mimeType=\"video/mp4\"><SegmentTemplate timescale=\"1\" duration=\"10\" media=\"v$RepresentationID$-$Number$.m4s\"/>\
<Representation id=\"lo\" bandwidth=\"500\" height=\"360\"/><Representation id=\"hi\" bandwidth=\"2000\" height=\"720\"/></AdaptationSet>\
<AdaptationSet mimeType=\"audio/mp4\" lang=\"en\"><SegmentTemplate timescale=\"1\" duration=\"10\" media=\"a-$Number$.m4s\"/>\
<Representation id=\"a1\" bandwidth=\"64\"/><Representation id=\"a2\" bandwidth=\"128\"/></AdaptationSet>\
<AdaptationSet mimeType=\"text/vtt\"><Representation id=\"t\" bandwidth=\"1\"/></AdaptationSet></Period>",
        );
        let d = parse(&text, BASE).unwrap();
        assert_eq!(d.title.as_deref(), Some("My film"));
        assert_eq!(d.video.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["v0.0", "v0.1"]);
        assert_eq!(d.audio.len(), 1);
        assert_eq!(d.audio[0].index, 1);
        assert_eq!(d.audio[0].lang.as_deref(), Some("en"));
        assert_eq!(d.audio[0].best().unwrap().bandwidth, 128);
        assert_eq!(d.audio[0].reps[1].id, "a1.1");
        assert_eq!(d.duration_sec, 30.0);
    }

    #[test]
    fn dynamic_is_live() {
        let text = "<MPD type=\"dynamic\" mediaPresentationDuration=\"PT30S\"><Period/></MPD>";
        assert_eq!(parse(text, BASE), Err(StreamError::Live));
    }

    #[test]
    fn content_protection_is_protected() {
        let text = mpd(
            "<Period><AdaptationSet mimeType=\"video/mp4\"><ContentProtection schemeIdUri=\"urn:mpeg:dash:mp4protection:2011\" value=\"cenc\"/>\
<SegmentTemplate timescale=\"1\" duration=\"10\" media=\"s$Number$.m4s\"/><Representation id=\"r\" bandwidth=\"1\"/></AdaptationSet></Period>",
        );
        assert_eq!(parse(&text, BASE), Err(StreamError::Protected));
    }

    #[test]
    fn odd_manifests_are_unsupported() {
        assert_eq!(parse("not xml", BASE), Err(StreamError::Unsupported));
        assert_eq!(parse("<html/>", BASE), Err(StreamError::Unsupported));
        let two = mpd("<Period><AdaptationSet mimeType=\"video/mp4\"/></Period><Period/>");
        assert_eq!(parse(&two, BASE), Err(StreamError::Unsupported));
        let no_dur = "<MPD type=\"static\"><Period><AdaptationSet mimeType=\"video/mp4\"/></Period></MPD>";
        assert_eq!(parse(no_dur, BASE), Err(StreamError::Unsupported));
        let dtd = "<!DOCTYPE MPD [<!ENTITY a \"b\">]><MPD type=\"static\" mediaPresentationDuration=\"PT1S\"><Period/></MPD>";
        assert_eq!(parse(dtd, BASE), Err(StreamError::Unsupported));
    }

    #[test]
    fn too_many_segments_are_refused() {
        let text = mpd(
            "<Period><AdaptationSet mimeType=\"video/mp4\"><SegmentTemplate timescale=\"1000\" duration=\"1\" media=\"s$Number$.m4s\"/>\
<Representation id=\"r\" bandwidth=\"1\"/></AdaptationSet></Period>",
        );
        // 30 s at 1 ms per segment is 30,000 segments.
        let d = parse(&text, BASE).unwrap();
        assert_eq!(d.video[0].plan(), Err(StreamError::Unsupported));
    }
}
