package app.hsn.push

import java.nio.ByteBuffer
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

internal typealias Fields = Map<*, *>

internal data class Target(val hub: String, val key: ByteArray)

internal data class Alert(
  val hub: String,
  val seq: Long,
  val time: Long,
  val kind: String,
  val category: String,
  val device: Long?,
  val critical: Boolean,
  val armed: Boolean,
  val delayed: Boolean,
  val names: Fields,
  val detail: Fields,
  val action: String?,
)

/** Accepts the confirmed key and its staged replacement until the hub acknowledges the switch. */
internal fun targetFor(hub: String, generations: Fields, id: String): Target? {
  for (name in listOf("pending", "active")) {
    val record = generations[name] as? Fields ?: continue
    val body = record["body"] as? Fields ?: continue
    if (body["keyId"] == id)
      return Target(hub, Base64.getUrlDecoder().decode(body["key"] as String))
  }
  return null
}

/**
 * Authenticates before decoding. The routing id and decrypted hub must identify the same record.
 */
internal object Envelope {
  /** PUSH_H.hChars in packages/protocol/src/relay/push.ts. */
  private const val ENVELOPE_CHARS = 1763

  /** PUSH_H.sealedChars is the length of the base64url sealed body. */
  private const val SEALED_CHARS = 1744

  /** PUSH_H.nonceBytes is the nonce prefix of the decoded body. */
  private const val NONCE_BYTES = 12

  /** PUSH_H.keyIdBytes is encoded as two lowercase hex digits per byte. */
  private const val KEY_ID_HEX_CHARS = 8 * 2

  private val form = Regex("1\\.([0-9a-f]{${KEY_ID_HEX_CHARS}})\\.([A-Za-z0-9_-]{${SEALED_CHARS}})")
  private val identity = Regex("[a-z2-7]{26}")

  /** Opens protocol v1, accepting only its fixed length, UTF-8, padding and content schema. */
  fun open(
    h: String,
    lookup: (String) -> Target?,
    decode: (String) -> Fields?,
    categories: Set<String>,
  ): Alert? {
    if (h.length != ENVELOPE_CHARS) return null
    val match = form.matchEntire(h) ?: return null
    val id = match.groupValues[1]
    val target = lookup(id) ?: return null
    return runCatching {
        val sealed = Base64.getUrlDecoder().decode(match.groupValues[2])
        val cipher = Cipher.getInstance("ChaCha20-Poly1305")
        cipher.init(
          Cipher.DECRYPT_MODE,
          SecretKeySpec(target.key, "ChaCha20"),
          IvParameterSpec(sealed, 0, NONCE_BYTES),
        )
        cipher.updateAAD(
          "hsn-push/1\u0000".toByteArray() +
            id.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        )
        val plain = cipher.doFinal(sealed, NONCE_BYTES, sealed.size - NONCE_BYTES)
        val end = plain.indexOfLast { it != 0.toByte() }
        if (end <= 0 || plain[end] != 0x80.toByte()) return null
        val text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(plain, 0, end)).toString()
        val content = decode(text) ?: return null
        parse(content, categories)?.takeIf { it.hub == target.hub }
      }
      .getOrNull()
  }

  /** Protocol numbers must be integral, nonnegative and representable exactly in JavaScript. */
  private fun integer(value: Any?, max: Long = 9007199254740991): Long? {
    val n = value as? Number ?: return null
    val l = n.toLong()
    return l.takeIf { l in 0..max && n.toDouble() == l.toDouble() }
  }

  /** Checks the protocol's character bounds including non-BMP display names. */
  private fun bounded(value: Any?) =
    value is String && value.codePointCount(0, value.length) in 1..64

  /** Checks every required and optional field before it can affect notification state. */
  private fun parse(c: Fields, categories: Set<String>): Alert? {
    val required = setOf("v", "hub", "n", "delayed", "names", "actions", "armed")
    if (c.keys != required && c.keys != required + "detail") return null
    val hub = c["hub"] as? String ?: return null
    if (integer(c["v"]) != 1L || !identity.matches(hub)) return null
    val n = c["n"] as? Fields ?: return null
    if (
      n.keys != setOf("seq", "atMs", "clockOk", "kind", "category", "critical", "device", "cause")
    )
      return null
    if (n["clockOk"] !is Boolean || !bounded(n["kind"]) || n["category"] !in categories) return null
    if (n["cause"] != null && integer(n["cause"]) == null) return null
    val device = integer(n["device"], 4294967295)
    if (n["device"] != null && (device == null || device < 1)) return null
    val names = c["names"] as? Fields ?: return null
    if (
      names.any {
        it.key !in setOf("device", "person", "client", "mode", "schedule") || !bounded(it.value)
      }
    )
      return null
    val detail =
      if ("detail" in c) c["detail"] as? Fields ?: return null else emptyMap<String, Any>()
    if (
      detail.any {
        !bounded(it.key) ||
          !(it.value is String ||
            it.value is Boolean ||
            (it.value as? Number)?.toDouble()?.isFinite() == true)
      }
    )
      return null
    val actions = c["actions"] as? List<*> ?: return null
    if (actions.size > 1 || actions.any { it != "disarm" && it != "armAway" }) return null
    return Alert(
      hub,
      integer(n["seq"]) ?: return null,
      integer(n["atMs"]) ?: return null,
      n["kind"] as String,
      n["category"] as String,
      device,
      n["critical"] as? Boolean ?: return null,
      c["armed"] as? Boolean ?: return null,
      c["delayed"] as? Boolean ?: return null,
      names,
      detail,
      actions.firstOrNull() as? String,
    )
  }
}

/**
 * One display decision; string tags keep different hubs and the entire u32 device range distinct.
 */
internal data class Display(val tag: String, val cancel: String?, val critical: Boolean)

/**
 * Selects the channel using the previous armed state and resolves the relay's reserved zero
 * sequence.
 */
internal fun display(
  alert: Alert,
  lastArmed: Boolean,
  seen: Boolean,
  lastRelay: String?,
): Display? {
  val relay = alert.seq == 0L && alert.kind in setOf("hub_unreachable", "hub_back")
  if (if (relay) lastRelay == alert.kind else seen) return null
  val countdown = alert.device?.let { "${alert.hub}/countdown/$it" }
  val tag =
    when {
      relay -> "${alert.hub}/relay"
      alert.category == "countdown" && countdown != null -> countdown
      else -> "${alert.hub}/${alert.seq}"
    }
  val loud =
    when (alert.kind) {
      "hub_unreachable" -> lastArmed
      "hub_back" -> false
      else -> alert.critical
    }
  return Display(tag, countdown.takeIf { alert.category == "alarm" }, loud)
}
