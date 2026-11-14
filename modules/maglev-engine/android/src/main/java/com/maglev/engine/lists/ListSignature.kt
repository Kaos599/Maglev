package com.maglev.engine.lists

import android.util.Base64
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Checks the signature on the source list file (docs/NATIVE_CONTRACT.md section 31.1). Same on every API level. */
object ListSignature {
    /**
     * True only when [sigB64] (base64 of the DER signature) is a valid `SHA256withECDSA` signature of the UTF-8 bytes
     * of [body] under the embedded key. Anything else, including bad base64, returns false. Never throws.
     */
    fun verify(body: String, sigB64: String): Boolean = verifyWith(ListKeys.PUBLIC_KEY_SPKI_B64, body, sigB64)

    /** [verify] with an explicit key, so a unit test can use its own pair. */
    fun verifyWith(publicKeySpkiB64: String, body: String, sigB64: String): Boolean = try {
        val keySpec = X509EncodedKeySpec(Base64.decode(publicKeySpkiB64, Base64.DEFAULT))
        val key = KeyFactory.getInstance("EC").generatePublic(keySpec)
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initVerify(key)
        sig.update(body.toByteArray(Charsets.UTF_8))
        sig.verify(Base64.decode(sigB64.trim(), Base64.DEFAULT))
    } catch (_: Throwable) {
        false
    }
}
