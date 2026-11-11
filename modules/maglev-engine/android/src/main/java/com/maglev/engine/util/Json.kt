package com.maglev.engine.util

import org.json.JSONArray
import org.json.JSONObject

/** JSON helpers. The single snake_case <-> camelCase converter lives here. */
object Json {
    private val snakeRe = Regex("_([a-z0-9])")
    private val camelRe = Regex("([a-z0-9])([A-Z])")

    fun snakeToCamel(s: String): String = snakeRe.replace(s) { it.groupValues[1].uppercase() }

    fun camelToSnake(s: String): String =
        camelRe.replace(s) { it.groupValues[1] + "_" + it.groupValues[2].lowercase() }

    /** Failure envelope as a raw (snake_case) map. */
    fun failure(code: String, message: String): Map<String, Any?> =
        linkedMapOf("ok" to false, "code" to code, "message" to message)

    /** Parses a JSON object into Maps/Lists. Keys are left untouched. Never throws. */
    fun parseObject(text: String?): Map<String, Any?> {
        if (text.isNullOrBlank()) return failure("INTERNAL", "Empty response from engine")
        return try {
            @Suppress("UNCHECKED_CAST")
            fromJson(JSONObject(text)) as Map<String, Any?>
        } catch (e: Exception) {
            failure("INTERNAL", "Unreadable response from engine")
        }
    }

    /** Recursively renames snake_case keys to camelCase. Values are never touched. */
    fun camelize(value: Any?): Any? = when (value) {
        is Map<*, *> -> {
            val out = LinkedHashMap<String, Any?>(value.size)
            for ((k, v) in value) out[snakeToCamel(k.toString())] = camelize(v)
            out
        }
        is List<*> -> value.map { camelize(it) }
        else -> value
    }

    /** Recursively renames camelCase keys to snake_case, for input going to Rust. */
    fun snakeify(value: Any?): Any? = when (value) {
        is Map<*, *> -> {
            val out = LinkedHashMap<String, Any?>(value.size)
            for ((k, v) in value) out[camelToSnake(k.toString())] = snakeify(v)
            out
        }
        is List<*> -> value.map { snakeify(it) }
        else -> value
    }

    /** Serializes Maps/Lists to JSON. Integral doubles become longs so Rust integer fields parse. */
    fun toJson(value: Any?): String = toJsonValue(value).toString()

    private fun toJsonValue(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { o ->
            for ((k, v) in value) o.put(k.toString(), toJsonValue(v))
        }
        is Iterable<*> -> JSONArray().also { a -> for (v in value) a.put(toJsonValue(v)) }
        is Array<*> -> JSONArray().also { a -> for (v in value) a.put(toJsonValue(v)) }
        is IntArray -> JSONArray().also { a -> for (v in value) a.put(v) }
        is Double ->
            if (value.isFinite() && value == Math.rint(value) && Math.abs(value) < 9.0e15) value.toLong() else value
        is Float ->
            if (value.isFinite() && value == Math.rint(value.toDouble()).toFloat()) value.toLong() else value.toDouble()
        is Number, is Boolean, is String -> value
        else -> value.toString()
    }

    private fun fromJson(v: Any?): Any? = when (v) {
        null, JSONObject.NULL -> null
        is JSONObject -> {
            val out = LinkedHashMap<String, Any?>()
            val keys = v.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                out[k] = fromJson(v.opt(k))
            }
            out
        }
        is JSONArray -> (0 until v.length()).map { fromJson(v.opt(it)) }
        else -> v
    }

    @Suppress("UNCHECKED_CAST")
    fun list(v: Any?): List<Map<String, Any?>> =
        (v as? List<*>)?.filterIsInstance<Map<String, Any?>>() ?: emptyList()

    fun long(v: Any?): Long = (v as? Number)?.toLong() ?: 0L
}
