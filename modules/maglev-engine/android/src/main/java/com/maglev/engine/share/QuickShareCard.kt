package com.maglev.engine.share

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.maglev.engine.R

/** What a button on the card does. The activity decides how. */
enum class CardAction { DOWNLOAD, DOWNLOAD_ANYWAY, OPEN_IN_MAGLEV, FREE_UP_SPACE, FIND_VIDEOS, CLOSE }

enum class Glyph { MAGNET, FILE, PAGE, WARNING }

class CardButton(val action: CardAction, val label: String, val enabled: Boolean = true)

/** Everything the card shows. The activity builds one per state; [QuickShareCard.render] draws it. */
data class CardState(
    val glyph: Glyph,
    val title: String,
    val detail: String?,
    val savesTo: String?,
    val warning: String?,
    val primary: CardButton,
    val secondary: CardButton?,
)

/** Colours of the three app themes (constants/theme.ts palettes). Kotlin holds a copy because the card runs with no JS. */
class CardPalette(
    val dim: Int, val card: Int, val raised: Int, val border: Int, val text: Int, val muted: Int,
    val accent: Int, val onAccent: Int, val warning: Int, val cyan: Int,
)

/**
 * The bottom card, drawn with plain Android Views (no Compose): void dim, surface card, 1px hairline, no shadow,
 * accent primary button, 44dp targets (docs/contracts-0.19/quick-share.md section 4).
 */
class QuickShareCard(
    private val context: Context,
    private val palette: CardPalette,
    private val onAction: (CardAction) -> Unit,
    private val onDismiss: () -> Unit,
) {
    companion object {
        /** `mode` is the saved Appearance mode: oled, dim, light or system (system follows the phone). */
        fun palette(context: Context, mode: String): CardPalette {
            val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
            val resolved = if (mode == "system") (if (night) "dim" else "light") else mode
            return when (resolved) {
                "light" -> CardPalette(
                    dim = Color.parseColor("#8015171A"), card = Color.parseColor("#FFFFFF"), raised = Color.parseColor("#ECECE4"),
                    border = Color.parseColor("#DAD9CF"), text = Color.parseColor("#15171A"), muted = Color.parseColor("#52555C"),
                    accent = Color.parseColor("#4D7C0F"), onAccent = Color.parseColor("#FFFFFF"), warning = Color.parseColor("#8A5200"),
                    cyan = Color.parseColor("#0369A1"),
                )
                "dim" -> CardPalette(
                    dim = Color.parseColor("#99111317"), card = Color.parseColor("#181B21"), raised = Color.parseColor("#1F232A"),
                    border = Color.parseColor("#2A2F38"), text = Color.parseColor("#ECEEF1"), muted = Color.parseColor("#A3AAB5"),
                    accent = Color.parseColor("#CCFF00"), onAccent = Color.parseColor("#111317"), warning = Color.parseColor("#FFB020"),
                    cyan = Color.parseColor("#00E5FF"),
                )
                else -> CardPalette(
                    dim = Color.parseColor("#9905070A"), card = Color.parseColor("#0D1117"), raised = Color.parseColor("#161B22"),
                    border = Color.parseColor("#1F2937"), text = Color.parseColor("#F3F4F6"), muted = Color.parseColor("#8B949E"),
                    accent = Color.parseColor("#CCFF00"), onAccent = Color.parseColor("#05070A"), warning = Color.parseColor("#FFB020"),
                    cyan = Color.parseColor("#00E5FF"),
                )
            }
        }

        private val GLYPHS = mapOf(
            Glyph.MAGNET to listOf(".aa..aa.", ".aa..aa.", ".XX..XX.", ".XX..XX.", ".XX..XX.", ".XXXXXX.", "..XXXX.."),
            Glyph.FILE to listOf("XXXXXX..", "X....XX.", "X....X.X", "X....XXX", "X......X", "X......X", "X......X", "XXXXXXXX"),
            Glyph.PAGE to listOf("XXXXXXXX", "X......X", "XXXXXXXX", "X.X..X.X", "X..XX..X", "X.X..X.X", "X......X", "XXXXXXXX"),
            Glyph.WARNING to listOf("...XX...", "...XX...", "..X..X..", "..X..X..", ".X.XX.X.", ".X.XX.X.", "X......X", "XXXXXXXX"),
        )
        private val CLOSE = listOf("X......X", ".X....X.", "..X..X..", "...XX...", "...XX...", "..X..X..", ".X....X.", "X......X")
    }

    private val density = context.resources.displayMetrics.density
    private fun dp(v: Int) = (v * density).toInt()

    private val root = FrameLayout(context)
    private val card = LinearLayout(context)
    private val body = LinearLayout(context)

    val view: View get() = root

    init {
        root.setBackgroundColor(palette.dim)
        root.setOnClickListener { onDismiss() }
        card.orientation = LinearLayout.VERTICAL
        card.setOnClickListener { } // a tap on the card does not reach the dim behind it
        card.background = GradientDrawable().apply {
            setColor(palette.card)
            setStroke(dp(1), palette.border)
            cornerRadii = floatArrayOf(dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), 0f, 0f, 0f, 0f)
        }
        val side = dp(16)
        card.setPadding(side, dp(8), side, side)
        root.addView(card, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        // Edge to edge (Android 15+): keep the buttons clear of the navigation bar.
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            card.setPadding(side + bars.left, dp(8), side + bars.right, side + bars.bottom)
            insets
        }
        body.orientation = LinearLayout.VERTICAL
        card.addView(header())
        card.addView(body)
        card.alpha = 0f
        card.translationY = dp(48).toFloat()
        root.post { card.animate().alpha(1f).translationY(0f).setDuration(160).start() }
    }

    private fun header(): View {
        val row = LinearLayout(context)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        // The real Maglev mark (res/drawable/maglev_mark.xml, generated by scripts/build-logo.py), not a redrawn copy.
        row.addView(ImageView(context).apply {
            setImageResource(R.drawable.maglev_mark)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        })
        row.addView(label("Maglev", 13f, palette.muted, bold = true).apply { setPadding(dp(8), 0, 0, 0) })
        row.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        val close = FrameLayout(context)
        close.contentDescription = QuickShareText.CLOSE
        close.isClickable = true
        close.setOnClickListener { onDismiss() }
        close.addView(PixelView(context, CLOSE, mapOf('X' to palette.text), dp(2)), FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        row.addView(close, LinearLayout.LayoutParams(dp(44), dp(44)))
        return row
    }

    private fun label(text: String, sp: Float, color: Int, bold: Boolean = false) = TextView(context).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
        typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        includeFontPadding = false
    }

    /** Draws [s]. Call on the main thread. */
    fun render(s: CardState) {
        body.removeAllViews()
        val top = LinearLayout(context)
        top.orientation = LinearLayout.HORIZONTAL
        top.gravity = Gravity.CENTER_VERTICAL
        val tile = FrameLayout(context)
        tile.background = GradientDrawable().apply { setColor(palette.raised); setStroke(dp(1), palette.border); cornerRadius = dp(10).toFloat() }
        val tint = if (s.glyph == Glyph.WARNING) palette.warning else palette.text
        tile.addView(
            PixelView(context, GLYPHS.getValue(s.glyph), mapOf('X' to tint, 'a' to palette.cyan), dp(3)),
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        top.addView(tile, LinearLayout.LayoutParams(dp(48), dp(48)))
        val text = LinearLayout(context)
        text.orientation = LinearLayout.VERTICAL
        text.addView(label(s.title, 17f, palette.text, bold = true).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.MIDDLE })
        s.detail?.let { text.addView(label(it, 13f, palette.muted).apply { setPadding(0, dp(4), 0, 0); maxLines = 2; ellipsize = TextUtils.TruncateAt.END }) }
        top.addView(text, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(12) })
        body.addView(top, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
        s.savesTo?.let { body.addView(label("${QuickShareText.SAVES_TO} $it", 13f, palette.muted).apply { setPadding(0, dp(14), 0, 0); maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE }) }
        s.warning?.let { body.addView(label(it, 13f, palette.warning, bold = true).apply { setPadding(0, dp(10), 0, 0) }) }
        body.addView(button(s.primary, primary = true), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(16) })
        s.secondary?.let { body.addView(button(it, primary = false), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(8) }) }
    }

    private fun button(b: CardButton, primary: Boolean): View {
        val fill = if (primary) palette.accent else Color.TRANSPARENT
        val pressedFill = if (primary) ColorUtils.setAlphaComponent(palette.accent, 0xCC) else palette.raised
        fun shape(color: Int) = GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(10).toFloat()
            if (!primary) setStroke(dp(1), palette.border)
        }
        val tv = label(b.label, 15f, if (primary) palette.onAccent else palette.text, bold = true).apply {
            gravity = Gravity.CENTER
            minHeight = dp(44)
            isEnabled = b.enabled
            alpha = if (b.enabled) 1f else 0.5f
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), shape(pressedFill))
                addState(intArrayOf(), shape(fill))
            }
            isClickable = b.enabled
            setOnClickListener { if (b.enabled) onAction(b.action) }
        }
        return tv
    }
}

/** A grid of squares from text rows. Characters not in [colors] stay empty. */
class PixelView(context: Context, private val rows: List<String>, private val colors: Map<Char, Int>, private val cell: Int) : View(context) {
    private val paint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = false }
    private val cols = rows.maxOf { it.length }

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(cols * cell, rows.size * cell)
    }

    override fun onDraw(canvas: Canvas) {
        for ((y, row) in rows.withIndex()) {
            for ((x, ch) in row.withIndex()) {
                val c = colors[ch] ?: continue
                paint.color = c
                canvas.drawRect((x * cell).toFloat(), (y * cell).toFloat(), ((x + 1) * cell).toFloat(), ((y + 1) * cell).toFloat(), paint)
            }
        }
    }
}
