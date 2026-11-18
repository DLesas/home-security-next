// The hub's certificate on the home network (m3-design.md section 2, D132), iOS's side: React
// Native's own WebSocket (SocketRocket) accepts the certificate a hub presents when, and only
// when, the URL's host is a private, link-local or loopback address or a `.local` name. TLS is
// carriage there: Noise, with the hub's key pinned at linking, proves the hub. Every other
// connection (the relay's among them) keeps the system's checks, through React Native's own
// socket. Copied into the generated project by `plugins/hub-tls.cjs`; installed as the app loads.
#import <Foundation/Foundation.h>
#import <SocketRocket/SocketRocket.h>
#import <React/RCTWebSocketModule.h>
#include <arpa/inet.h>

/** A host as written in the URL: an address literal on the home network, or a `.local` name. */
static BOOL HSNIsHomeHost(NSString *host)
{
  if (host.length == 0) {
    return NO;
  }
  NSString *bare = host.lowercaseString;
  if ([bare hasPrefix:@"["] && [bare hasSuffix:@"]"]) {
    bare = [bare substringWithRange:NSMakeRange(1, bare.length - 2)];
  }
  if ([bare hasSuffix:@".local"]) {
    return YES;
  }
  struct in_addr v4;
  if (inet_pton(AF_INET, bare.UTF8String, &v4) == 1) {
    uint32_t a = ntohl(v4.s_addr);
    return (a >> 24) == 10 || (a >> 24) == 127 || (a >> 20) == 0xAC1 || (a >> 16) == 0xC0A8 ||
        (a >> 16) == 0xA9FE;
  }
  struct in6_addr v6;
  if (inet_pton(AF_INET6, bare.UTF8String, &v6) == 1) {
    const uint8_t *b = v6.s6_addr;
    BOOL loopback = IN6_IS_ADDR_LOOPBACK(&v6);
    BOOL uniqueLocal = (b[0] & 0xFE) == 0xFC;
    BOOL linkLocal = b[0] == 0xFE && (b[1] & 0xC0) == 0x80;
    return loopback || uniqueLocal || linkLocal;
  }
  return NO;
}

/** For a home host only: the system's chain check off, and the presented certificate taken. */
@interface HSNHubSecurityPolicy : SRSecurityPolicy
@end

@implementation HSNHubSecurityPolicy

- (void)updateSecurityOptionsInStream:(NSStream *)stream
{
  // SocketRocket's own settings (its TLS level), then the chain check off: this policy is only
  // ever given to a socket whose host is a home host.
  [super updateSecurityOptionsInStream:stream];
  [stream setProperty:@{(__bridge id)kCFStreamSSLValidatesCertificateChain : @NO}
               forKey:(__bridge id)kCFStreamPropertySSLSettings];
}

- (BOOL)evaluateServerTrust:(SecTrustRef)serverTrust forDomain:(NSString *)domain
{
  return HSNIsHomeHost(domain);
}

@end

__attribute__((constructor)) static void HSNInstallHubSocketProvider(void)
{
  RCTSetCustomSRWebSocketProvider(^SRWebSocket *(NSURLRequest *request) {
    NSURL *url = request.URL;
    if (![url.scheme.lowercaseString isEqualToString:@"wss"] || !HSNIsHomeHost(url.host)) {
      return nil; // React Native's own socket, with the system's checks.
    }
    return [[SRWebSocket alloc] initWithURLRequest:request
                                         protocols:nil
                                    securityPolicy:[HSNHubSecurityPolicy new]];
  });
}
