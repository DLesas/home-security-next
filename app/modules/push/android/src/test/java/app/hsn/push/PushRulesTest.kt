package app.hsn.push

import groovy.json.JsonSlurper
import java.io.File

/** Converts public vector bytes silently so a failed assertion cannot print key material. */
private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

/** JVM test entry invoked by Gradle without an emulator, Firebase, JUnit or another dependency. */
fun main(args: Array<String>) {
    val json = JsonSlurper()
    val vectors = json.parse(File(args[0])) as Map<*,*>
    val good = vectors["seal"] as List<*>
    val bad = vectors["open"] as List<*>
    val categories = good.map { (((it as Fields)["content"] as Fields)["n"] as Fields)["category"] as String }.toSet()
    val alerts = good.map { row ->
        val v = row as Fields
        val content = v["content"] as Fields
        val n = content["n"] as Fields
        val a = Envelope.open(v["h"] as String, { id -> if(id == v["keyId"]) Target(content["hub"] as String,hex(v["key"] as String)) else null },
            { (json.parseText(it) as? Fields).also { opened -> check(opened == content) } }, categories)
        check(a != null && a.hub == content["hub"] && a.seq == (n["seq"] as Number).toLong() && a.kind == n["kind"] &&
            a.time == (n["atMs"] as Number).toLong() && a.category == n["category"] && a.device == (n["device"] as? Number)?.toLong() &&
            a.critical == n["critical"] && a.armed == content["armed"] && a.delayed == content["delayed"] &&
            a.names == content["names"] && a.action == (content["actions"] as List<*>).singleOrNull() &&
            a.detail == (content["detail"] ?: emptyMap<String,Any>())) { "good vector: ${v["name"]}" }
        a
    }
    for (row in bad) {
        val v = row as Fields
        check(Envelope.open(v["h"] as String, { id -> if(id == v["keyId"]) Target(alerts.first().hub,hex(v["key"] as String)) else null },
            {json.parseText(it) as? Fields},categories) == null) { "refusal: ${v["name"]}" }
    }
    val countdown = alerts.first()
    val alarm = alerts[1]
    val unreachable = alerts.first { it.kind=="hub_unreachable" }
    val back = alerts.first { it.kind=="hub_back" }
    check(display(countdown,false,true,null)==null)
    check(display(countdown,false,false,null)?.critical==true)
    check(display(countdown.copy(critical=false),true,false,null)?.critical==false)
    check(display(unreachable.copy(critical=true),false,false,null)?.critical==false)
    check(display(unreachable,true,false,null)?.critical==true)
    check(display(back,true,true,"hub_unreachable")?.critical==false)
    check(display(back,false,true,"hub_back")==null)
    check(display(unreachable,false,true,"hub_back")!=null)
    val tag = display(countdown,false,false,null)!!.tag
    check(display(alarm,false,false,null)?.cancel==tag)
    check(display(alarm.copy(device=999),false,false,null)?.cancel!=tag)
    check(display(alarm.copy(hub="other"),false,false,null)?.cancel!=tag)
    check(display(countdown,false,false,null)?.cancel==null)
    val words = AlertWords(json.parse(File(args[1])) as Fields,json.parse(File(args[2])) as Fields) { it.toString() }
    check(words.text(countdown,null,0) == ("Countdown" to "${countdown.names["device"]} opened at ${countdown.time}."))
    val late = words.text(alarm.copy(detail=mapOf("endedAtMs" to 42)), "Cottage", 70).second
    check(late.startsWith("Cottage. ") && late.endsWith("Delayed: happened at 42."))
    check(!words.text(countdown.copy(delayed=false),null,0).second.contains("Delayed"))
    check(words.text(unreachable,null,180010).second.contains("since about 10."))
    check(words.text(back,null,0).first == "Home hub is back")
    check(words.text(alarm.copy(kind="new_kind"),null,0).second.startsWith("Something happened at home."))
    println("Passed ${good.size} opening vectors, ${bad.size} refusals and 18 notification rules.")
}
