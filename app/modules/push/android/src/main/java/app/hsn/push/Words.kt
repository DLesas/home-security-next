package app.hsn.push

import android.content.Context
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** Translations from the app's locale assets, also available when the JS bundle is asleep. */
internal class Words(private val context: Context) {
    private val locale = context.resources.configuration.locales[0] ?: Locale.ENGLISH
    /** Tries the device's language followed by the app's English fallback. */
    private fun load(file: String): JSONObject {
        for (lang in listOf(locale.toLanguageTag(), locale.language, "en").distinct()) {
            val text = runCatching { context.assets.open("push/$lang/$file.json").bufferedReader().use { it.readText() } }.getOrNull()
            if (text != null) return JSONObject(text)
        }
        return JSONObject()
    }
    private val common = load("common")
    private val push = load("push")
    private val categories = common.getJSONObject("notifications").getJSONObject("category")
    val categoryNames = categories.keys().asSequence().toSet()

    /** Gets a notification-only translation, including action and channel names. */
    fun word(key: String): String = push.getString(key)

    /** Renders full clock times and substitutes names as data, without reinterpreting their contents. */
    fun text(a: Alert, home: String?, received: Long): Pair<String,String> {
        val at = if (a.kind == "hub_unreachable") received-180000 else
            (a.detail["endedAtMs"] as? Number)?.toLong() ?: (a.detail["openedAtMs"] as? Number)?.toLong() ?: a.time
        val time = DateFormat.getTimeInstance(DateFormat.SHORT,locale).format(Date(at))
        val device = a.names["device"] as? String ?: word("device")
        val custom = push.optJSONObject(a.kind)
        val decision = common.getJSONObject("history").getJSONObject("decision").optString(a.kind)
        val event = common.getJSONObject("history").optJSONObject("hubEvent")?.optString(a.kind).orEmpty()
        val kindText = decision.ifEmpty { event }
        val category = categories.getString(a.category)
        val (title, raw) = when {
            custom != null -> custom.getString("title") to custom.getString("body")
            a.kind in setOf("countdown_started","countdown") -> category to word("countdown")
            a.kind in setOf("alarm","late_report_sirens","late_report_notification") -> category to word("alarm")
            kindText.isNotEmpty() -> category to (kindText + if (a.names["device"] != null) ": {{device}}." else ".")
            else -> word("unknownTitle") to word("unknown")
        }
        val body = raw.replace("{{time}}",time).replace("{{device}}",device) +
            if (a.delayed) " " + word("delayed").replace("{{time}}",time) else ""
        return title to if (home == null) body else word("home").replace("{{body}}",body).replaceFirst("{{home}}",home)
    }
}
