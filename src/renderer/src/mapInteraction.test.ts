import { describe, expect, it } from 'vitest'
import { mapInteraction } from './mapInteraction'

describe('mapInteraction', () => {
  it('locks panning while following, with an aircraft on the map', () => {
    expect(mapInteraction(true, true, true)).toEqual({
      dragPan: false,
      keyboard: false,
      scrollZoom: { around: 'center' },
      touchZoomRotate: { around: 'center' },
      doubleClickZoom: false
    })
  })

  it('does not lock a live, following map with no aircraft yet (a planned-flight preview)', () => {
    expect(mapInteraction(true, true, false)).toEqual({
      dragPan: true,
      keyboard: true,
      scrollZoom: true,
      touchZoomRotate: true,
      doubleClickZoom: true
    })
  })

  it('does not lock a live map with follow turned off', () => {
    expect(mapInteraction(true, false, true)).toEqual({
      dragPan: true,
      keyboard: true,
      scrollZoom: true,
      touchZoomRotate: true,
      doubleClickZoom: true
    })
  })

  it('does not lock Logbook’s static (non-live) map, even if the flags passed in look like following', () => {
    expect(mapInteraction(false, true, true)).toEqual({
      dragPan: true,
      keyboard: true,
      scrollZoom: true,
      touchZoomRotate: true,
      doubleClickZoom: true
    })
  })

  it('does not lock when neither live nor following nor an aircraft', () => {
    expect(mapInteraction(false, false, false)).toEqual({
      dragPan: true,
      keyboard: true,
      scrollZoom: true,
      touchZoomRotate: true,
      doubleClickZoom: true
    })
  })
})
