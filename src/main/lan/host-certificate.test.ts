import { createHash, createPublicKey, X509Certificate, createPrivateKey } from 'node:crypto'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { certificatePin, makeHostCertificate } from './host-certificate'

describe('makeHostCertificate', () => {
  it('makes a certificate Node reads back, signed by its own key', () => {
    const { certDer, certPem, keyPem } = makeHostCertificate()
    const certificate = new X509Certificate(certDer)
    expect(certificate.verify(createPublicKey(certPem))).toBe(true)
    expect(certificate.checkPrivateKey(createPrivateKey(keyPem))).toBe(true)
    expect(new X509Certificate(certPem).raw.equals(certDer)).toBe(true)
  })

  it('has the designed shape: one name for subject and issuer, 2000 to 9999, ecdsa-with-SHA256, no extensions or names', () => {
    const certificate = new X509Certificate(makeHostCertificate().certDer)
    expect(certificate.subject).toBe('CN=WingLog sim PC')
    expect(certificate.issuer).toBe('CN=WingLog sim PC')
    expect(certificate.validFromDate.toISOString()).toBe('2000-01-01T00:00:00.000Z')
    expect(certificate.validToDate.toISOString()).toBe('9999-12-31T23:59:59.000Z')
    expect(certificate.signatureAlgorithm).toBe('ecdsa-with-SHA256')
    expect(certificate.publicKey.asymmetricKeyType).toBe('ec')
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(certificate.subjectAltName).toBeUndefined()
    expect(certificate.ca).toBe(false)
    expect(certificate.keyUsage).toBeUndefined()
  })

  it('gives every call its own key and serial, and a positive 16-byte serial', () => {
    const first = makeHostCertificate()
    const second = makeHostCertificate()
    expect(first.keyPem).not.toBe(second.keyPem)
    const serials = [first, second].map((made) => new X509Certificate(made.certDer).serialNumber)
    expect(serials[0]).not.toBe(serials[1])
    for (const serial of serials) expect(serial).toMatch(/^[4-7][0-9A-F]{31}$/)
  })

  it('keeps the key in the PEM only, never in the certificate', () => {
    const { keyPem, certPem } = makeHostCertificate()
    expect(keyPem).toContain('PRIVATE KEY')
    expect(certPem).not.toContain('PRIVATE')
  })
})

describe('certificatePin', () => {
  it('is the SHA-256 of the certificate as 43 base64url characters, the same as Node reports', () => {
    const { certDer } = makeHostCertificate()
    const pin = certificatePin(certDer)
    expect(pin).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const fingerprint = new X509Certificate(certDer).fingerprint256.replaceAll(':', '')
    expect(Buffer.from(pin, 'base64url').toString('hex')).toBe(fingerprint.toLowerCase())
    expect(pin).toBe(createHash('sha256').update(certDer).digest('base64url'))
  })

  it('differs between certificates', () => {
    expect(certificatePin(makeHostCertificate().certDer)).not.toBe(
      certificatePin(makeHostCertificate().certDer)
    )
  })
})

describe('the certificate in a real TLS handshake (Electron uses BoringSSL, which is stricter than OpenSSL)', () => {
  let server: Server | null = null
  afterEach(() => {
    server?.close()
    server?.closeAllConnections()
    server = null
  })

  it('completes a TLS 1.3 handshake and shows the pinned certificate to the client', async () => {
    const { keyPem, certPem, certDer } = makeHostCertificate()
    server = createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.3' })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const seen = await new Promise<{ protocol: string | null; raw: Buffer }>((resolve, reject) => {
      // Nothing is trusted here: the test only reads what the server shows.
      const socket = connect(
        { host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' },
        () => {
          resolve({ protocol: socket.getProtocol(), raw: socket.getPeerCertificate().raw })
          socket.destroy()
        }
      )
      socket.once('error', reject)
    })
    expect(seen.protocol).toBe('TLSv1.3')
    expect(certificatePin(seen.raw)).toBe(certificatePin(certDer))
  })
})
