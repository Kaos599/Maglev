package com.maglev.engine.lists

/**
 * The public key that signs `lists/sources.json` (docs/NATIVE_CONTRACT.md section 31.1): ECDSA P-256,
 * SubjectPublicKeyInfo DER, base64. The private key lives only in the `LISTS_SIGNING_KEY` repo secret.
 */
object ListKeys {
    const val PUBLIC_KEY_SPKI_B64 =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEo/K39XPtsV9ze1Vt0q7OZ7w76SEZ+3KYLjJeCQp50nOqv/CFj9pS+g3b/+oxWs+ExRF3KnA8OThbi3cJJZzJ0g=="
}
