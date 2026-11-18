// The hub's certificate on the home network (m3-design.md section 2, D132), Android's side:
// React Native's own WebSocket (OkHttp) accepts the certificate a hub presents when, and only
// when, the connection is to a private, link-local or loopback address or a `.local` name. TLS is
// carriage there: Noise, with the hub's key pinned at linking, proves the hub. Every other
// connection (the relay's among them) keeps the system's checks. Copied into the generated
// project by `plugins/hub-tls.cjs`; installed from `MainApplication.onCreate`.
package org.hsn.hubtls

import com.facebook.react.modules.websocket.WebSocketModule
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

object HubTls {
  /** An address on the home network or this device: never a name looked up here. */
  fun isHomeAddress(address: InetAddress?): Boolean {
    if (address == null) return false
    if (address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress) {
      return true
    }
    // IPv6 unique local, fc00::/7 (Java's "site local" is the old fec0::/10).
    return address is Inet6Address && (address.address[0].toInt() and 0xfe) == 0xfc
  }

  /** A host as written in the URL: an address literal on the home network, or a `.local` name. */
  fun isHomeHost(host: String?): Boolean {
    if (host == null) return false
    val bare = host.removePrefix("[").removeSuffix("]").lowercase()
    if (bare.endsWith(".local")) return true
    val literal = bare.matches(Regex("^[0-9.]+$")) || bare.contains(':')
    return literal && isHomeAddress(runCatching { InetAddress.getByName(bare) }.getOrNull())
  }

  private fun systemTrust(): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  fun install() {
    val system = systemTrust()
    val trust =
        object : X509ExtendedTrustManager() {
          override fun checkServerTrusted(
              chain: Array<X509Certificate>,
              authType: String,
              socket: Socket?,
          ) {
            if (!isHomeAddress(socket?.inetAddress)) system.checkServerTrusted(chain, authType)
          }

          override fun checkServerTrusted(
              chain: Array<X509Certificate>,
              authType: String,
              engine: SSLEngine?,
          ) {
            if (!isHomeHost(engine?.peerHost)) system.checkServerTrusted(chain, authType)
          }

          override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
              system.checkServerTrusted(chain, authType)

          override fun checkClientTrusted(
              chain: Array<X509Certificate>,
              authType: String,
              socket: Socket?,
          ) = system.checkClientTrusted(chain, authType)

          override fun checkClientTrusted(
              chain: Array<X509Certificate>,
              authType: String,
              engine: SSLEngine?,
          ) = system.checkClientTrusted(chain, authType)

          override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
              system.checkClientTrusted(chain, authType)

          override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
        }
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trust), null)
    val names: HostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
    WebSocketModule.setCustomClientBuilder { builder ->
      builder.sslSocketFactory(context.socketFactory, trust)
      builder.hostnameVerifier { host, session -> isHomeHost(host) || names.verify(host, session) }
    }
  }
}
