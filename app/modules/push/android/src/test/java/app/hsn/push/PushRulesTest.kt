package app.hsn.push

import groovy.json.JsonSlurper
import java.io.File
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** The fresh public corpus. Only test names and indexes reach the JUnit reporter. */
private object Corpus {
  private val json = JsonSlurper()
  private val vectors = load("push.vectors")
  val good = rows("seal")
  val bad = rows("open")
  val categories =
    good.map { (((it["content"] as Fields)["n"] as Fields)["category"] as String) }.toSet()

  /** Reads one generated vector file or app dictionary supplied by the Gradle task. */
  fun load(property: String) = json.parse(File(System.getProperty(property))) as Fields

  /** Reads rows by corpus name, keeping public keys out of assertion messages. */
  private fun rows(group: String) = (vectors[group] as List<*>).map { it as Fields }

  /** Opens through the same Kotlin code as the Android service, substituting a JVM JSON reader. */
  fun open(v: Fields, hub: String, validate: (Fields) -> Unit = {}): Alert? {
    return Envelope.open(
      v["h"] as String,
      { id ->
        if (id != v["keyId"]) null
        else
          Target(hub, (v["key"] as String).chunked(2).map { it.toInt(16).toByte() }.toByteArray())
      },
      { text -> (json.parseText(text) as? Fields)?.also(validate) },
      categories,
    )
  }

  /** Supplies an authenticated alert for display-rule tests. */
  fun goodAt(index: Int): Alert {
    val row = good[index]
    val content = row["content"] as Fields
    return checkNotNull(open(row, content["hub"] as String) { check(it == content) })
  }
}

/** Every published accept/refuse vector has its own test and a non-secret display name. */
@RunWith(Parameterized::class)
class EnvelopeTest(private val good: Boolean, private val index: Int, private val name: String) {
  companion object {
    /** Enumerates case identities without giving JUnit the raw fixture records. */
    @JvmStatic
    @Parameterized.Parameters(name = "{2}")
    fun cases(): List<Array<Any>> =
      Corpus.good.mapIndexed { index, row -> arrayOf<Any>(true, index, row["name"] as String) } +
        Corpus.bad.mapIndexed { index, row -> arrayOf<Any>(false, index, row["name"] as String) }
  }

  /** Validates the complete plaintext and every field subsequently used by the service. */
  @Test
  fun publishedResult() {
    if (!good) {
      val hub = (Corpus.good.first()["content"] as Fields)["hub"] as String
      check(Corpus.open(Corpus.bad[index], hub) == null) { name }
      return
    }
    val a = Corpus.goodAt(index)
    val c = Corpus.good[index]["content"] as Fields
    val n = c["n"] as Fields
    check(a.seq == (n["seq"] as Number).toLong() && a.time == (n["atMs"] as Number).toLong())
    check(
      a.kind == n["kind"] &&
        a.category == n["category"] &&
        a.device == (n["device"] as? Number)?.toLong()
    )
    check(a.critical == n["critical"] && a.armed == c["armed"] && a.delayed == c["delayed"])
    check(a.names == c["names"] && a.action == (c["actions"] as List<*>).singleOrNull())
    check(a.detail == (c["detail"] ?: emptyMap<String, Any>()))
  }
}

/** Device-independent policy tests using the app's dictionaries and opened protocol vectors. */
class PushRulesTest {
  private val countdown = Corpus.goodAt(0)
  private val alarm = Corpus.goodAt(1)
  private val unreachable = Corpus.goodAt(5)
  private val back = Corpus.goodAt(6)
  private val words =
    AlertWords(Corpus.load("push.common"), Corpus.load("push.words")) { it.toString() }

  /** The service itself can still open a previously sealed alert while a new key is staged. */
  @Test
  fun keyOverlap() {
    val v = Corpus.good.first()
    val key = (v["key"] as String).chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val encoded = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(key)
    val old = mapOf("body" to mapOf("keyId" to v["keyId"], "key" to encoded))
    val new = mapOf("body" to mapOf("keyId" to "0000000000000000", "key" to encoded))
    fun open(gens: Fields) =
      Envelope.open(
        v["h"] as String,
        { targetFor(countdown.hub, gens, it) },
        { JsonSlurper().parseText(it) as? Fields },
        Corpus.categories,
      )
    check(open(mapOf("active" to old, "pending" to new)) == countdown)
    check(open(mapOf("active" to new, "pending" to null)) == null)
    check(open(mapOf("active" to null, "pending" to old)) == countdown)
  }

  /** Positive sequences already shown are silent. */
  @Test
  fun duplicate() {
    check(display(countdown, false, true, null) == null)
  }

  /**
   * Runs the production schema on SQLite and feeds its actual repeat lookup into the display rule.
   */
  @Test
  fun newestSequencesPerHub() {
    val script =
      """
            import { Database } from "bun:sqlite";
            const sql = JSON.parse(await Bun.stdin.text());
            const db = new Database(":memory:");
            db.exec(sql.table);
            const insert = db.query("INSERT OR IGNORE INTO shown VALUES (?, ?)");
            for (let i = 1; i <= 600; i++) insert.run("upgraded", i);
            db.query(sql.pruneExisting).run("upgraded");
            db.exec(sql.trigger);
            insert.run("neighbour", 1);
            for (let i = 600; i >= 1; i--) insert.run("current", i);
            const rows = db.query("SELECT seq FROM shown WHERE hub = ? ORDER BY seq");
            for (const hub of ["current", "upgraded", "neighbour"]) {
                console.log(rows.values(hub).flat().join(","));
            }
            console.log(db.query("SELECT 1 FROM shown WHERE hub = ? AND seq = ?").get("current", 550) !== null);
        """
        .trimIndent()
    val sqlite = ProcessBuilder("bun", "-e", script).redirectErrorStream(true).start()
    sqlite.outputStream.bufferedWriter().use {
      it.write(
        groovy.json.JsonOutput.toJson(
          mapOf(
            "table" to ShownHistory.table,
            "pruneExisting" to ShownHistory.pruneExisting,
            "trigger" to ShownHistory.trigger,
          )
        )
      )
    }
    val rows = sqlite.inputStream.bufferedReader().use { it.readLines() }
    check(sqlite.waitFor() == 0) { rows.joinToString() }
    val newest = (101..600).joinToString(",")
    check(rows.take(3) == listOf(newest, newest, "1"))
    val seen = rows.last().toBooleanStrict()
    check(display(countdown.copy(hub = "current", seq = 550), false, seen, null) == null)
  }

  /** The ordinary envelope becomes loud only after the alert is opened. */
  @Test
  fun criticalFlag() {
    check(display(countdown, false, false, null)?.critical == true)
    check(display(countdown.copy(critical = false), true, false, null)?.critical == false)
  }

  /** Reachability uses this phone's previous state, with separate consecutive outages allowed. */
  @Test
  fun relayAlerts() {
    check(display(unreachable.copy(critical = true), false, false, null)?.critical == false)
    check(display(unreachable, true, false, null)?.critical == true)
    check(display(back, true, true, "hub_unreachable")?.critical == false)
    check(display(back, false, true, "hub_back") == null)
    check(display(unreachable, false, true, "hub_back") != null)
  }

  /** Only the countdown from this alarm's device and home is cancelled. */
  @Test
  fun replacement() {
    val tag = checkNotNull(display(countdown, false, false, null)).tag
    check(display(alarm, false, false, null)?.cancel == tag)
    check(display(alarm.copy(device = 999), false, false, null)?.cancel != tag)
    check(display(alarm.copy(hub = "other"), false, false, null)?.cancel != tag)
    check(display(countdown, false, false, null)?.cancel == null)
  }

  /** A delayed alert includes its actual event time, after the home-specific body. */
  @Test
  fun wording() {
    check(
      words.text(countdown, null, 0) ==
        ("Countdown" to "${countdown.names["device"]} opened at ${countdown.time}.")
    )
    val late = words.text(alarm.copy(detail = mapOf("endedAtMs" to 42)), "Cottage", 70).second
    check(late.startsWith("Cottage. ") && late.endsWith("Delayed: happened at 42."))
    check(!words.text(countdown.copy(delayed = false), null, 0).second.contains("Delayed"))
    check(words.text(unreachable, null, 180010).second.contains("since about 10."))
    check(words.text(back, null, 0).first == "Home hub is back")
    check(
      words
        .text(alarm.copy(kind = "new_kind"), null, 0)
        .second
        .startsWith("Something happened at home.")
    )
  }
}
