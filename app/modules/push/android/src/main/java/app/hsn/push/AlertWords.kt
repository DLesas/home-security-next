package app.hsn.push

/** Renders authenticated notification content with the same local dictionaries as the app. */
internal class AlertWords(private val common: Fields, private val push: Fields, private val clock: (Long) -> String) {
    private val categories = (common["notifications"] as Fields)["category"] as Fields
    val categoryNames = categories.keys.filterIsInstance<String>().toSet()

    /** Gets notification-specific text, including actions, outcomes and channel names. */
    fun word(key: String): String = push[key] as String

    /** Replaces only template tokens, never tokens in a person's name or in substituted text. */
    private fun fill(template: String, values: Map<String,String>) =
        Regex("""\{\{([a-z]+)\}\}""").replace(template) { values[it.groupValues[1]] ?: it.value }

    /** Formats ordinary and delayed alerts, and uses arrival time for the relay's pre-sealed outage. */
    fun text(a: Alert, home: String?, received: Long): Pair<String,String> {
        val happened = (a.detail["endedAtMs"] as? Number)?.toLong()
            ?: (a.detail["openedAtMs"] as? Number)?.toLong() ?: a.time
        val time = clock(if (a.kind == "hub_unreachable") received - 180_000 else happened)
        val args = mapOf("time" to time, "device" to (a.names["device"] as? String ?: word("device")))
        val custom = push[a.kind] as? Fields
        val history = common["history"] as Fields
        val kindText = (history["decision"] as Fields)[a.kind] ?: (history["event"] as Fields)[a.kind]
        val category = categories[a.category] as String
        val (title, template) = when {
            custom != null -> (custom["title"] as String) to (custom["body"] as String)
            a.kind in setOf("countdown_started", "countdown") -> category to word("countdown")
            a.kind in setOf("alarm", "late_report_sirens", "late_report_notification") -> category to word("alarm")
            kindText is String -> category to (kindText.trimEnd('.') + if ("device" in a.names) ": {{device}}." else ".")
            else -> word("unknownTitle") to word("unknown")
        }
        val body = fill(template,args) + if (a.delayed) " " + fill(word("delayed"),args) else ""
        return title to if (home == null) body else fill(word("home"),mapOf("body" to body,"home" to home))
    }
}
