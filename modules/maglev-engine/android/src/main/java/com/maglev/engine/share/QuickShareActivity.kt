package com.maglev.engine.share

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.core.view.WindowCompat
import com.maglev.engine.EngineHost
import com.maglev.engine.storage.StorageManager
import java.util.concurrent.Executors
import kotlin.math.ln
import kotlin.math.pow

/**
 * The quick share card. A translucent activity that floats over the app the user
 * shared from. It receives magnet, .torrent, text and http(s) file links, shows what they are, and adds them to the
 * engine without opening Maglev's own window. "Open in Maglev" leaves the link in [ShareHandoff] and starts MainActivity
 * plainly. The same activity is the way in for Maglev's own notification and tile taps ([ShareHandoff.routeIntent]), so
 * that no page link is ever the start intent of the task.
 */
class QuickShareActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private val worker = Executors.newCachedThreadPool() // inspect() can wait 10 s; Download must not queue behind it

    private lateinit var original: Intent
    private lateinit var cls: ShareClass
    private var card: QuickShareCard? = null

    /** A `.torrent` copied to a path the core can read (content:// shares), or the path of a file:// share. */
    @Volatile private var localTorrent: String? = null
    @Volatile private var info = QuickShareAdd.Info(null, null, null, null)
    @Volatile private var existing: QuickShareAdd.Existing? = null
    @Volatile private var lowSpace: QuickShareAdd.LowSpace? = null
    @Volatile private var loaded = false
    @Volatile private var engineFailed = false
    @Volatile private var adding = false
    @Volatile private var addError = false
    @Volatile private var displayName: String? = null
    private var shape: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        EngineHost.attach(applicationContext)
        original = intent ?: Intent()
        // Maglev's own notification and tile taps: no card, straight to the app through the one-shot store. The card is
        // exported, so only an allowlisted route is accepted; a rejected one just closes. Reading an extra unpacks the
        // whole extras bundle, and a caller can put a class we do not have in it, which throws. An uncaught throw here
        // would take the engine's process down with the card, so the read is guarded like every other one in this file.
        val route = try { original.getStringExtra(ShareHandoff.EXTRA_OPEN_ROUTE) } catch (e: Exception) { null }
        if (route != null) {
            if (ShareHandoff.allowedRoute(route)) launchApp(route) else rejectRoute()
            return
        }
        // Maglev's own route intents carry data and no action. Data with no action and no readable route is a route we
        // could not accept, not a share, so it must not fall through to the "No link" card.
        if (original.action == null && original.data != null) {
            rejectRoute()
            return
        }
        if (original.action == Intent.ACTION_SEND_MULTIPLE) {
            // Several torrent files: MainActivity queues them (utils/shareQueue.ts).
            openMaglev(null)
            return
        }
        val (texts, mime) = candidates(original)
        cls = ShareClassify.classifyFirst(texts, mime)
        if (cls.kind == ShareKind.NONE) {
            shape = handOffShape(original)
            Log.i(TAG, "No link in a hand-off:\n$shape")
        }
        if (original.action == Intent.ACTION_VIEW) cls = ShareClassify.withHandOffName(cls, handOffName(original))
        // A web page can start a BROWSABLE VIEW, so that one always shows the card and never earns the trusted mark below.
        val fromBrowser = original.action == Intent.ACTION_VIEW && original.hasCategory(Intent.CATEGORY_BROWSABLE)
        // Video sites (prototype): a shared YouTube, X or Instagram page goes straight to the add sheet, which
        // reads the video and lists qualities. Same host list as utils/videoSites.ts VIDEO_SITE_HOSTS.
        if (!fromBrowser && cls.kind == ShareKind.WEB_PAGE && isVideoSite(host(cls.source))) {
            // The stored entry carries this exact link as trusted, so the add screen reads it at once. A maglev:// link
            // from a web page or another app never gets a mark and still waits for a tap.
            launchApp("maglev://add-download?url=" + Uri.encode(cls.source ?: ""), cls.source)
            return
        }
        val addable = cls.kind == ShareKind.MAGNET || cls.kind == ShareKind.TORRENT_FILE || cls.kind == ShareKind.FILE_LINK
        if (addable && !fromBrowser && QuickSharePrefs.addWithoutAsking(applicationContext)) {
            setContentView(View(this))
            addWithoutCard()
            return
        }
        val c = QuickShareCard(this, QuickShareCard.palette(this, QuickSharePrefs.appearanceMode(applicationContext)), ::onAction, ::finish)
        card = c
        setContentView(c.view)
        render()
        if (addable) inspect()
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    // region intent

    /**
     * Every place a hand-off can carry the link, in order (issue #162). Text extras are read as CharSequence: a browser
     * that sends styled text (a SpannableString) gets null from getStringExtra, and the link was lost. A shared file
     * no longer hides the URL text next to it: [ShareClassify.classifyFirst] keeps the first candidate with a link.
     */
    @Suppress("DEPRECATION")
    private fun candidates(i: Intent): Pair<List<String?>, String?> {
        val out = ArrayList<String?>()
        fun text(key: String) = try { i.getCharSequenceExtra(key)?.toString() } catch (e: Exception) { null }
        fun uri(key: String) = try {
            if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(key, Uri::class.java)?.toString() else i.getParcelableExtra<Uri>(key)?.toString()
        } catch (e: Exception) { null }
        fun plain(key: String) = try { i.extras?.get(key)?.toString() } catch (e: Exception) { null }
        when (i.action) {
            Intent.ACTION_SEND -> { out += uri(Intent.EXTRA_STREAM); out += text(Intent.EXTRA_TEXT) }
            Intent.ACTION_VIEW -> out += i.dataString
            // Text-selection menu: the selected text, read only. We never return replacement text, so the selection stays as it was.
            Intent.ACTION_PROCESS_TEXT -> return listOf(text(Intent.EXTRA_PROCESS_TEXT)) to null
            else -> return emptyList<String?>() to null
        }
        val clip = i.clipData
        if (clip != null) for (n in 0 until clip.itemCount) {
            val item = clip.getItemAt(n)
            out += item.uri?.toString()
            out += item.text?.toString()
        }
        out += text(Intent.EXTRA_TEXT)
        out += text(Intent.EXTRA_SUBJECT)
        out += uri(Intent.EXTRA_ORIGINATING_URI)
        for (k in LINK_EXTRAS) out += plain(k)
        return out to i.type
    }

    /** The hand-off's shape for "Copy details" and the log: names and value types only (ShareClassify.describeHandOff). */
    @Suppress("DEPRECATION")
    private fun handOffShape(i: Intent): String {
        val extras = try {
            i.extras?.keySet()?.sorted()?.map { k -> k to (i.extras?.get(k)?.javaClass?.simpleName ?: "null") } ?: emptyList()
        } catch (e: Exception) { emptyList() }
        val clip = i.clipData
        val items = if (clip == null) emptyList() else (0 until clip.itemCount).map { n ->
            val item = clip.getItemAt(n)
            listOfNotNull(item.uri?.scheme?.let { s -> "uri $s" }, item.text?.let { t -> "text ${t.javaClass.simpleName}" }, item.intent?.let { "intent" })
                .joinToString(" + ").ifEmpty { "empty" }
        }
        return ShareClassify.describeHandOff(i.action, i.type, i.data?.scheme, extras, items)
    }

    /** The file name a browser sends with a download hand-off: ADM's extra first, then the generic one. */
    private fun handOffName(i: Intent): String? = try {
        i.getStringExtra("com.android.extra.filename") ?: i.getStringExtra("filename")
    } catch (e: Exception) {
        null // a caller can put any type under these keys
    }

    /** MainActivity with the original intent, or with [uri] when given. Then this card goes away. */
    private fun openMaglev(uri: Uri?) {
        val link = if (::cls.isInitialized) cls.source else null
        val isLocalUri = link != null && (link.startsWith("content://", true) || link.startsWith("file://", true))
        when {
            uri != null -> launchApp(uri.toString())
            // MainActivity does not read PROCESS_TEXT: hand it the link that was found in the selection.
            original.action == Intent.ACTION_PROCESS_TEXT && link != null -> launchApp(link)
            // Several torrent files, or one local file: copy each while this card still holds the read grant.
            original.action == Intent.ACTION_SEND_MULTIPLE -> keepLocalTorrents(streamUris(original), true)
            link != null && isLocalUri -> keepLocalTorrents(listOf(link), false)
            // Hand over the extracted link directly (e.g. from SpannableString, clipData, EXTRA_SUBJECT, LINK_EXTRAS,
            // or EXTRA_TEXT alongside a preview image EXTRA_STREAM) so MainActivity does not re-parse and lose it.
            link != null -> launchApp(link)
            else -> launchApp(null)
        }
    }

    private fun rejectRoute() {
        Log.w(TAG, "route rejected")
        finish()
    }

    /** The link waits in the one-shot store and the app starts with no data. Null starts the app with nothing waiting. */
    private fun launchApp(link: String?, trustedUrl: String? = null) {
        val launcher = packageManager.getLaunchIntentForPackage(packageName)
        val main = launcher?.component
        if (launcher == null || main == null) { finish(); return }
        // A link carried as the start intent would come back whenever Android rebuilt the task. Kept in the store, it is
        // read once and gone, so a later start from the launcher icon is never mistaken for this share.
        if (link != null) ShareHandoff.put(applicationContext, link, trustedUrl)
        val i = Intent(launcher)
        i.component = main
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(i)
        } catch (e: Exception) {
            // Nothing to show: the card still closes.
        }
        finish()
    }

    /**
     * Copies each local .torrent into the cache (off the main thread) and hands over the copies, because the read grant
     * of the original dies with this card. Several files travel as one packed maglev://share link. A file that cannot be
     * kept is skipped and a toast says how many were kept; if none can, the card says so and nothing opens.
     */
    private fun keepLocalTorrents(sources: List<String>, packed: Boolean) {
        val app = applicationContext
        worker.execute {
            val kept = sources.take(ShareHandoff.MAX_FILES).mapNotNull { ShareHandoff.keepLocalTorrent(app, it, original.type) }
            ui.post {
                if (isDestroyed) return@post
                when {
                    kept.isEmpty() -> { toast(QuickShareText.COULD_NOT_ADD); finish() }
                    !packed && kept.size == 1 -> launchApp(kept[0])
                    else -> {
                        if (kept.size < sources.size) toast(QuickShareText.someKept(kept.size, sources.size))
                        launchApp("maglev://share?" + kept.joinToString("&") { "u=" + Uri.encode(it) })
                    }
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun streamUris(i: Intent): List<String> {
        val out = ArrayList<String>()
        try {
            val list: List<Uri>? = if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            list?.forEach { out += it.toString() }
        } catch (e: Exception) {
            // A sender can put any type under the key: fall through to the clip.
        }
        val clip = i.clipData
        if (out.isEmpty() && clip != null) for (n in 0 until clip.itemCount) clip.getItemAt(n).uri?.let { out += it.toString() }
        return out
    }

    // endregion

    // region state

    private fun isVideoSite(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return VIDEO_SITE_HOSTS.any { h == it || h.endsWith(".$it") }
    }

    private fun host(url: String?): String? = url?.let {
        val h = Regex("^https?://([^/?#]+)", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)?.substringAfterLast('@')
            ?: return@let null
        when {
            h.startsWith('[') -> h.indexOf(']').takeIf { i -> i > 0 }?.let { i -> h.substring(0, i + 1) } ?: h
            else -> h.substringBefore(':')
        }.takeIf { it.isNotEmpty() }
    }

    private fun folderName(): String {
        val t = StorageManager.activeTarget(applicationContext)
        val tree = t.treeUri
        if (tree != null && t.mode != "default") {
            val last = Uri.parse(tree).lastPathSegment ?: ""
            return last.substringAfter(':').ifEmpty { last }.ifEmpty { t.path }
        }
        return t.path.trimEnd('/').split('/').filter { it.isNotEmpty() }.takeLast(2).joinToString("/")
    }

    private fun size(bytes: Long): String {
        if (bytes < 1) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var i = (ln(bytes.toDouble()) / ln(1024.0)).toInt().coerceIn(0, units.size - 1)
        var v = bytes / 1024.0.pow(i)
        if (v >= 1023.5 && i < units.size - 1) { i += 1; v /= 1024 }
        return "${if (i == 0 || v >= 99.95) "%.0f".format(v) else "%.1f".format(v)} ${units[i]}"
    }

    private fun render() {
        card?.render(stateNow())
    }

    private fun stateNow(): CardState {
        val open = CardButton(CardAction.OPEN_IN_MAGLEV, QuickShareText.OPEN_IN_MAGLEV)
        val close = CardButton(CardAction.CLOSE, QuickShareText.CLOSE)
        return when (cls.kind) {
            ShareKind.NONE -> CardState(
                Glyph.WARNING, QuickShareText.NO_LINK, null, null, null, close,
                CardButton(CardAction.COPY_DETAILS, QuickShareText.COPY_DETAILS),
            )
            ShareKind.WEB_PAGE -> CardState(
                Glyph.PAGE, QuickShareText.WEB_PAGE, host(cls.source), null, null,
                CardButton(CardAction.FIND_VIDEOS, QuickShareText.FIND_VIDEOS), close,
            )
            else -> {
                val glyph = if (cls.kind == ShareKind.FILE_LINK) Glyph.FILE else Glyph.MAGNET
                val title = info.name ?: displayName ?: cls.name ?: when (cls.kind) {
                    ShareKind.MAGNET -> QuickShareText.MAGNET_NAME
                    ShareKind.TORRENT_FILE -> QuickShareText.TORRENT_NAME
                    else -> QuickShareAdd.displayUrl(cls.source ?: "").ifEmpty { QuickShareText.SIZE_UNKNOWN }
                }
                val source = when (cls.kind) {
                    ShareKind.MAGNET -> QuickShareText.MAGNET_NAME
                    ShareKind.TORRENT_FILE -> host(cls.source) ?: QuickShareText.TORRENT_NAME
                    else -> host(cls.source) ?: ""
                }
                val sizeText = when {
                    info.sizeBytes != null -> size(info.sizeBytes!!) + (info.fileCount?.takeIf { it > 1 }?.let { " · $it files" } ?: "")
                    !loaded -> QuickShareText.GETTING_DETAILS
                    else -> QuickShareText.SIZE_UNKNOWN
                }
                val detail = listOf(sizeText, source).filter { it.isNotEmpty() }.joinToString(" · ")
                val e = existing
                val low = lowSpace
                when {
                    engineFailed -> CardState(Glyph.WARNING, title, detail, null, QuickShareText.ENGINE_FAILED, close, open)
                    e != null -> CardState(glyph, title, "${QuickShareText.ALREADY_IN} · ${e.percent}% done", null, null, open, null)
                    low != null -> CardState(
                        Glyph.WARNING, title, detail, folderName(), "Needs ${size(low.needBytes)}, ${size(low.freeBytes)} free",
                        CardButton(CardAction.DOWNLOAD_ANYWAY, QuickShareText.DOWNLOAD_ANYWAY, !adding),
                        CardButton(CardAction.FREE_UP_SPACE, QuickShareText.FREE_UP_SPACE),
                    )
                    else -> CardState(
                        glyph, title, detail, folderName(), if (addError) QuickShareText.COULD_NOT_ADD else null,
                        if (adding) CardButton(CardAction.DOWNLOAD, QuickShareText.ADDING, false) else CardButton(CardAction.DOWNLOAD, QuickShareText.DOWNLOAD),
                        open,
                    )
                }
            }
        }
    }

    // endregion

    // region work

    /** Reads what the source is: starts the engine, asks the core, checks for a duplicate and for space. Updates the card when done. */
    private fun inspect() {
        val app = applicationContext
        worker.execute {
            if (cls.kind == ShareKind.TORRENT_FILE && cls.source?.let { it.startsWith("content://", true) || it.startsWith("file://", true) } == true) {
                localTorrent = QuickShareAdd.localize(app, cls.source!!)
                if (cls.name == null && cls.source!!.startsWith("content://", true)) displayName = QuickShareAdd.displayName(app, cls.source!!)
                ui.post { render() }
            }
            if (!QuickShareAdd.startEngine(app)) {
                engineFailed = true
                loaded = true
                ui.post { render() }
                return@execute
            }
            val got = QuickShareAdd.inspect(cls, localTorrent)
            info = got
            existing = QuickShareAdd.findExisting(cls, got)
            lowSpace = if (existing == null) got.sizeBytes?.let { QuickShareAdd.lowSpace(it) } else null
            loaded = true
            ui.post { render() }
        }
    }

    private fun onAction(a: CardAction) {
        when (a) {
            CardAction.CLOSE -> finish()
            CardAction.OPEN_IN_MAGLEV -> openMaglev(null)
            CardAction.FREE_UP_SPACE -> openMaglev(Uri.parse("maglev://free-space"))
            CardAction.FIND_VIDEOS -> openMaglev(Uri.parse("maglev://browser?url=" + Uri.encode(cls.source ?: "")))
            CardAction.DOWNLOAD, CardAction.DOWNLOAD_ANYWAY -> download()
            CardAction.COPY_DETAILS -> copyDetails()
        }
    }

    /** Copies the hand-off's shape (no values) so a bug report can say how the other app sent it (issue #162). */
    private fun copyDetails() {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("Maglev share details", shape))
            Toast.makeText(this, QuickShareText.DETAILS_COPIED, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            // Nothing else to do: the card stays.
        }
    }

    private fun download() {
        if (adding) return
        adding = true
        addError = false
        render()
        val app = applicationContext
        worker.execute {
            // A magnet still being read must stop first, or the add would wait for it.
            cls.infoHash?.let { if (!loaded) EngineHost.cancelResolve(it) }
            if (cls.kind == ShareKind.TORRENT_FILE && localTorrent == null && cls.source?.startsWith("content://", true) == true) {
                localTorrent = QuickShareAdd.localize(app, cls.source!!)
            }
            val out = QuickShareAdd.add(app, cls, localTorrent)
            ui.post { finishAdd(out) }
        }
    }

    /** No card: add now, say so with a Toast, close. A duplicate says so instead. */
    private fun addWithoutCard() {
        val app = applicationContext
        worker.execute {
            if (cls.kind == ShareKind.TORRENT_FILE && cls.source?.let { it.startsWith("content://", true) || it.startsWith("file://", true) } == true) {
                localTorrent = QuickShareAdd.localize(app, cls.source!!)
            }
            val out = QuickShareAdd.add(app, cls, localTorrent)
            ui.post { finishAdd(out) }
        }
    }

    private fun finishAdd(out: QuickShareAdd.Outcome) {
        adding = false
        when {
            out.ok -> {
                toast(if (out.serviceBlocked) QuickShareText.ADDED_SERVICE_LATER else QuickShareText.ADDED)
                finish()
            }
            out.duplicate -> {
                if (card == null) { toast(QuickShareText.ALREADY_IN); finish(); return }
                existing = QuickShareAdd.Existing(0)
                render()
                worker.execute {
                    val e = QuickShareAdd.findExisting(cls, info)
                    if (e != null) { existing = e; ui.post { render() } }
                }
            }
            out.code == "ENGINE_UNAVAILABLE" -> {
                if (card == null) { toast(QuickShareText.ENGINE_FAILED); finish(); return }
                engineFailed = true
                render()
            }
            else -> {
                if (card == null) { toast(QuickShareText.COULD_NOT_ADD); finish(); return }
                addError = true
                render()
            }
        }
    }

    private fun toast(text: String) {
        Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show()
    }

    // endregion

    private companion object {
        val VIDEO_SITE_HOSTS = listOf("youtube.com", "youtu.be", "x.com", "twitter.com", "instagram.com", "reddit.com", "vimeo.com", "tiktok.com")

        const val TAG = "MaglevShare"

        /** Extras download managers (1DM, ADM) and some browsers use for the link (issue #162). Read only as text. */
        val LINK_EXTRAS = listOf("url", "link", "uri", "android.intent.extra.URL", "com.android.browser.application_id_url")
    }
}
