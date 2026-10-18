import { describe, expect, it } from 'vitest'
import { deviceNameFrom } from './device-name'

describe('deviceNameFrom', () => {
  it('names real browsers by device and browser', () => {
    const cases: [string, string][] = [
      [
        'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'iPad (Safari)'
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
        'iPhone (Chrome)'
      ],
      [
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        'Android phone (Chrome)'
      ],
      [
        'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Android tablet (Chrome)'
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
        'Windows PC (Edge)'
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Mac (Firefox)'
      ],
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Linux PC (Chrome)']
    ]
    for (const [userAgent, name] of cases) expect(deviceNameFrom(userAgent)).toBe(name)
  })

  it('names only what it recognises, or "Browser"', () => {
    expect(deviceNameFrom('Mozilla/5.0 (Unknown) Firefox/1.0')).toBe('Firefox')
    expect(deviceNameFrom('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows PC')
    expect(deviceNameFrom('')).toBe('Browser')
  })
})
