//! Drop-in replacement for `rustls-platform-verifier` 0.6 (only the surface reqwest 0.13 uses).
//!
//! The real crate needs a JNI init and a Kotlin component on Android. This one validates server
//! certificates with rustls' WebPKI verifier against the bundled Mozilla root set, so it works
//! on every target with no setup. Trade-off: user-installed CAs and OS revocation data are not
//! consulted.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error as TlsError, RootCertStore, SignatureScheme};

/// Certificate verifier backed by bundled Mozilla roots plus optional extra roots.
#[derive(Debug)]
pub struct Verifier {
    inner: Arc<WebPkiServerVerifier>,
}

/// Mozilla roots as a rustls store.
pub fn bundled_roots() -> RootCertStore {
    let mut store = RootCertStore::empty();
    store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    store
}

impl Verifier {
    pub fn new(crypto_provider: Arc<CryptoProvider>) -> Result<Self, TlsError> {
        Self::new_with_extra_roots(Vec::<CertificateDer<'static>>::new(), crypto_provider)
    }

    pub fn new_with_extra_roots(
        extra_roots: impl IntoIterator<Item = CertificateDer<'static>>,
        crypto_provider: Arc<CryptoProvider>,
    ) -> Result<Self, TlsError> {
        let mut store = bundled_roots();
        for cert in extra_roots {
            store.add(cert)?;
        }
        let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(store), crypto_provider)
            .build()
            .map_err(|e| TlsError::General(format!("cannot build certificate verifier: {e}")))?;
        Ok(Self { inner })
    }
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_root_store_is_not_empty() {
        assert!(bundled_roots().len() > 100);
    }
}
