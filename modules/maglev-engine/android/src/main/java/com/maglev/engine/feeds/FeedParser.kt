package com.maglev.engine.feeds

import org.xmlpull.v1.XmlPullParser

/** One feed entry. [source] is a magnet URI or a .torrent URL, or null when the item has neither. */
data class FeedItem(val title: String, val guid: String, val source: String?)

/**
 * RSS 2.0 and Atom parser over XmlPullParser (contract section 11.6).
 * The caller creates the parser (Xml.newPullParser() on Android, KXmlParser in JVM tests) and sets its input.
 * Names are compared without their namespace prefix, so this works whether or not the parser is namespace aware.
 */
object FeedParser {

    fun parse(p: XmlPullParser): List<FeedItem> {
        val out = ArrayList<FeedItem>()
        var event = p.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG && (local(p.name) == "item" || local(p.name) == "entry")) {
                readItem(p)?.let { out.add(it) }
            }
            event = p.next()
        }
        return out
    }

    private fun local(name: String?): String = (name ?: "").substringAfter(':').lowercase()

    private fun attr(p: XmlPullParser, name: String): String? {
        for (i in 0 until p.attributeCount) {
            if (local(p.getAttributeName(i)) == name) return p.getAttributeValue(i)
        }
        return null
    }

    private fun readItem(p: XmlPullParser): FeedItem? {
        val container = local(p.name)
        var title = ""
        var guid = ""
        var link = ""
        var enclosure: String? = null
        var magnetAttr: String? = null
        var infoHash: String? = null
        var depth = 1
        while (depth > 0) {
            when (p.next()) {
                XmlPullParser.START_TAG -> {
                    depth++
                    val raw = p.name ?: ""
                    when (local(raw)) {
                        "title" -> title = text(p).also { depth-- }.trim()
                        "guid", "id" -> guid = text(p).also { depth-- }.trim()
                        "link" -> {
                            val href = attr(p, "href")
                            if (href != null) {
                                // Atom. rel defaults to "alternate".
                                if (attr(p, "rel") == "enclosure") enclosure = enclosure ?: href
                                else if (link.isEmpty() || attr(p, "rel") == null || attr(p, "rel") == "alternate") link = href
                            } else {
                                link = text(p).also { depth-- }.trim()
                            }
                        }
                        "enclosure" -> {
                            val url = attr(p, "url")
                            val type = attr(p, "type")?.lowercase() ?: ""
                            if (url != null && (type.contains("bittorrent") || isTorrentish(url))) enclosure = enclosure ?: url
                        }
                        "attr" -> {
                            // torznab:attr and newznab-style attr elements
                            when (attr(p, "name")?.lowercase()) {
                                "magneturl" -> magnetAttr = attr(p, "value")
                                "infohash" -> infoHash = attr(p, "value")
                            }
                        }
                        "magneturl" -> magnetAttr = text(p).also { depth-- }.trim()
                        "infohash" -> infoHash = text(p).also { depth-- }.trim()
                    }
                }
                XmlPullParser.END_TAG -> depth--
                XmlPullParser.END_DOCUMENT -> depth = 0
            }
        }
        if (container != "item" && container != "entry") return null
        val source = pickSource(title, magnetAttr, enclosure, link, guid, infoHash)
        val id = guid.ifEmpty { link }
        if (id.isEmpty() && title.isEmpty()) return null
        return FeedItem(title, id.ifEmpty { title }, source)
    }

    /**
     * Reads the text of the current element and leaves the parser on its END_TAG.
     * Child elements are skipped. The caller must lower its depth by one, because the end tag is consumed here.
     */
    private fun text(p: XmlPullParser): String {
        val sb = StringBuilder()
        var d = 1
        while (d > 0) {
            when (p.next()) {
                XmlPullParser.TEXT, XmlPullParser.CDSECT -> if (d == 1) sb.append(p.text)
                XmlPullParser.START_TAG -> d++
                XmlPullParser.END_TAG -> d--
                XmlPullParser.END_DOCUMENT -> d = 0
            }
        }
        return sb.toString()
    }

    private fun isMagnet(s: String) = s.startsWith("magnet:", ignoreCase = true)
    private fun isTorrentish(s: String) = isMagnet(s) || s.substringBefore('?').endsWith(".torrent", ignoreCase = true)

    private fun pickSource(
        title: String, magnetAttr: String?, enclosure: String?, link: String, guid: String, infoHash: String?,
    ): String? {
        if (!magnetAttr.isNullOrBlank() && isMagnet(magnetAttr)) return magnetAttr
        if (!enclosure.isNullOrBlank()) return enclosure
        if (link.isNotEmpty() && isTorrentish(link)) return link
        if (isMagnet(guid)) return guid
        val hash = infoHash?.trim()
        if (hash != null && Regex("^[0-9a-fA-F]{40}$").matches(hash)) {
            val dn = java.net.URLEncoder.encode(title, "UTF-8")
            return "magnet:?xt=urn:btih:${hash.lowercase()}" + if (title.isNotEmpty()) "&dn=$dn" else ""
        }
        return null
    }
}
