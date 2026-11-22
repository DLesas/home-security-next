package app.hsn.push

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader

/** Android's strict streaming JSON reader, converted to ordinary JVM values at the edge. */
internal fun fields(text: String): Fields? = runCatching {
    JsonReader(StringReader(text)).use {
        val value = read(it, 0)
        if (it.peek() == JsonToken.END_DOCUMENT) value as? Fields else null
    }
}.getOrNull()

/** Reads one JSON value, limiting nesting before recursing on unauthenticated storage input. */
private fun read(r: JsonReader, depth: Int): Any? {
    require(depth < 32)
    return when (r.peek()) {
        JsonToken.BEGIN_OBJECT -> buildMap {
            r.beginObject()
            while (r.hasNext()) put(r.nextName(),read(r,depth+1))
            r.endObject()
        }
        JsonToken.BEGIN_ARRAY -> buildList {
            r.beginArray()
            while (r.hasNext()) add(read(r,depth+1))
            r.endArray()
        }
        JsonToken.STRING -> r.nextString()
        JsonToken.NUMBER -> r.nextString().let { it.toLongOrNull() ?: it.toDouble() }
        JsonToken.BOOLEAN -> r.nextBoolean()
        JsonToken.NULL -> r.nextNull().let { null }
        else -> error("Invalid JSON value")
    }
}
