package com.maglev.engine.share

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Toast
import androidx.core.view.WindowCompat
import com.maglev.engine.EngineHost
import com.maglev.engine.storage.StorageManager
import java.util.concurrent.Executors
import kotlin.math.ln
import kotlin.math.pow

/**
 * The quick share card (docs/contracts-0.19/quick-share.md). A translucent activity that floats over the app the user
 * shared from. It receives magnet, .torrent, text and http(s) file links, shows what they are, and adds them to the
 * engine without opening Maglev's own window. "Open in Maglev" hands the original intent to MainActivity.
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        EngineHost.attach(applicationContext)
        original = intent ?: Intent()
        if (original.action == Intent.ACTION_SEND_MULTIPLE) {
            // Several torrent files: MainActivity queues them (utils/shareQueue.ts).
            openMaglev(null)
            return
        }
        val (text, mime) = extract(original)
        cls = ShareClassify.classify(text, mime)
        val addable = cls.kind == ShareKind.MAGNET || cls.kind == ShareKind.TORRENT_FILE || cls.kind == ShareKind.FILE_LINK
        if (addable && QuickSharePrefs.addWithoutAsking(applicationContext)) {
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

    @Suppress("DEPRECATION")
    private fun extract(i: Intent): Pair<String?, String?> {
        val stream: Uri? = if (i.action == Intent.ACTION_SEND) {
            if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        } else null
        return when (i.action) {
            Intent.ACTION_SEND -> (stream?.toString() ?: i.getStringExtra(Intent.EXTRA_TEXT)) to i.type
            Intent.ACTION_VIEW -> i.dataString to i.type
            else -> null to null
        }
    }

    /** MainActivity with the original intent, or with [uri] when given. Then this card goes away. */
    private fun openMaglev(uri: Uri?) {
        val main = packageManager.getLaunchIntentForPackage(packageName)?.component
        if (main == null) { finish(); return }
        val i = if (uri != null) Intent(Intent.ACTION_VIEW, uri) else Intent(original)
        i.component = main
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(i)
        } catch (e: Exception) {
            // Nothing to show: the card still closes.
        }
        finish()
    }

    // endregion

    // region state

    private fun host(url: String?): String? = url?.let { Regex("^https?://([^/?#]+)", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)?.substringAfterLast('@') }

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
            ShareKind.NONE -> CardState(Glyph.WARNING, QuickShareText.NO_LINK, null, null, null, close, null)
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
        }
    }

    private fun download() {
        if (adding) return
        adding = true
        addError = false
        render()
        val app = applicationContext
        worker.execute {
            // A magnet still being read must stop first, or the add would wait for it (NATIVE_CONTRACT 10.4).
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
}
