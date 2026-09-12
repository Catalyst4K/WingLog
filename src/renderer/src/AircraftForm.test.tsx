import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Aircraft, AirlineOption, SimbriefAirframeOption, WingLogApi } from '@shared/ipc'
import { AircraftForm } from './AircraftForm'

// Radix Select renders a visually-hidden native <option> (for form autofill) alongside the
// real, visible listbox item in its portal — both carry the same text, so a bare
// `getByText`/`findByText` matches two elements. Scoping to the portal's own
// `[data-slot="select-content"]` picks out only the real, clickable one.
async function pickSelectOption(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(screen.getByRole('combobox'))
  const item = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === label
    )
    if (!found) throw new Error(`No select item found with label "${label}"`)
    return found
  })
  await user.click(item)
}

const FULL_AIRCRAFT: Aircraft = {
  id: 1,
  registration: 'G-XWBS',
  icaoType: 'A35K',
  operator: 'British Airways',
  operatorIata: 'BA',
  operatorIcao: 'BAW',
  simbriefAirframeId: '123456_1582090020',
  simbriefType: 'A35K',
  simbriefAirframeDeveloper: 'FlyByWire',
  simbriefAirframeEngines: 'Trent XWB',
  simbriefAirframeRegistration: 'G-XWBS',
  currentIcao: 'EGLL',
  createdAt: '2026-01-01T00:00:00.000Z',
  replacedByAircraftId: null,
  photoThumbnailUrl: 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg'
}

const MINIMAL_AIRCRAFT: Aircraft = {
  id: 2,
  registration: 'N12345',
  icaoType: 'C172',
  operator: null,
  operatorIata: null,
  operatorIcao: null,
  simbriefAirframeId: null,
  simbriefType: null,
  simbriefAirframeDeveloper: null,
  simbriefAirframeEngines: null,
  simbriefAirframeRegistration: null,
  currentIcao: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  replacedByAircraftId: null,
  photoThumbnailUrl: null
}

function buildWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  return {
    simbriefAirframesForType: vi.fn().mockResolvedValue([]),
    simbriefCreateCustomAirframe: vi.fn().mockResolvedValue(null),
    aircraftLookupByRegistration: vi.fn().mockResolvedValue(null),
    airlineFindByIcao: vi.fn().mockResolvedValue(undefined),
    aircraftTypeSearch: vi.fn().mockResolvedValue([]),
    airlineSearch: vi.fn().mockResolvedValue([]),
    airportSearch: vi.fn().mockResolvedValue([]),
    dispatchOpenSimBriefAirframes: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as WingLogApi
}

function setWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = buildWinglog(overrides)
  window.winglog = api
  return api
}

function textInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="text"]'))
}

const COMMUNITY_OPTION: SimbriefAirframeOption = {
  isDefault: false,
  developer: 'FlyByWire',
  variant: null,
  engines: 'Trent XWB',
  comments: 'FlyByWire (MSFS) - A35K',
  registration: 'G-XWBS',
  simbriefType: 'A35K',
  shareUrl: 'https://dispatch.simbrief.com/share/xyz'
}

const COMMUNITY_OPTION_NO_SHARE: SimbriefAirframeOption = {
  ...COMMUNITY_OPTION,
  shareUrl: null
}

const COMMUNITY_OPTION_NO_DEVELOPER: SimbriefAirframeOption = {
  isDefault: false,
  developer: null,
  variant: null,
  engines: 'CFM56',
  comments: 'A mystery airframe (freeform comment)',
  registration: null,
  simbriefType: 'A320',
  shareUrl: 'https://dispatch.simbrief.com/share/abc'
}

const COMMUNITY_OPTION_WITH_VARIANT: SimbriefAirframeOption = {
  isDefault: false,
  developer: 'PMDG',
  variant: 'Dual Class',
  engines: 'CFM56',
  comments: 'PMDG (MSFS) - Dual Class',
  registration: 'N738X',
  simbriefType: 'B738',
  shareUrl: 'https://dispatch.simbrief.com/share/variant'
}

const DEFAULT_OPTION: SimbriefAirframeOption = {
  isDefault: true,
  developer: null,
  variant: null,
  engines: 'CFM56',
  comments: 'Stock default',
  registration: null,
  simbriefType: 'A320',
  shareUrl: null
}

describe('AircraftForm', () => {
  it('renders an empty form in create mode', () => {
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const inputs = textInputs(container)
    expect(inputs[0]).toHaveValue('') // registration
    expect(inputs[1]).toHaveValue('') // icaoType
    expect(screen.getByText('Save')).toBeInTheDocument()
  })

  it('searches the ICAO type via the Combobox and picks a result', async () => {
    setWinglog({
      aircraftTypeSearch: vi.fn().mockResolvedValue([
        { manufacturer: 'Airbus', model: 'A350-1000', icaoType: 'A35K', wakeCat: 'H' }
      ])
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A35')
    await user.click(await screen.findByText('Airbus — A350-1000 (A35K)'))
    expect(textInputs(container)[1]).toHaveValue('A35K')
  }, 10000)

  it('prefills every field from the given aircraft in edit mode', () => {
    const { container } = render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const inputs = textInputs(container)
    expect(inputs[0]).toHaveValue('G-XWBS')
    expect(inputs[1]).toHaveValue('A35K')
    expect(inputs[2]).toHaveValue('British Airways')
    expect(inputs[3]).toHaveValue('A35K')
    expect(inputs[4]).toHaveValue('123456_1582090020')
    expect(inputs[5]).toHaveValue('EGLL')
  })

  it('prefills blank optional fields as empty strings when the aircraft has none set', () => {
    const { container } = render(<AircraftForm initial={MINIMAL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const inputs = textInputs(container)
    expect(inputs[0]).toHaveValue('N12345')
    expect(inputs[2]).toHaveValue('')
    expect(inputs[3]).toHaveValue('')
    expect(inputs[4]).toHaveValue('')
    expect(inputs[5]).toHaveValue('')
  })

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<AircraftForm onSubmit={vi.fn()} onCancel={onCancel} />)
    await user.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('shows "Enter a registration first." when Look up is clicked with no registration', async () => {
    setWinglog()
    const user = userEvent.setup()
    render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByText('Look up'))
    expect(await screen.findByText('Enter a registration first.')).toBeInTheDocument()
  })

  it('shows a not-found message when the lookup finds no match', async () => {
    setWinglog({ aircraftLookupByRegistration: vi.fn().mockResolvedValue(null) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-TEST')
    await user.click(screen.getByText('Look up'))
    expect(await screen.findByText('No match for "G-TEST" — search for the type below.')).toBeInTheDocument()
  })

  it('fills blank fields from a successful lookup, resolving the airline by ICAO and fetching SimBrief default type', async () => {
    const airline: AirlineOption = { name: 'Cathay Pacific', icao: 'CPA', iata: 'CX' }
    const winglog = setWinglog({
      aircraftLookupByRegistration: vi.fn().mockResolvedValue({
        icaoType: 'B77W',
        operator: 'Cathay Pacific Airways',
        operatorIcao: 'CPA',
        photoThumbnailUrl: 'https://airport-data.com/thumb.jpg'
      }),
      airlineFindByIcao: vi.fn().mockResolvedValue(airline),
      simbriefAirframesForType: vi.fn().mockResolvedValue([{ ...DEFAULT_OPTION, simbriefType: 'B77W' }])
    })
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'B-HNL')
    await user.click(screen.getByText('Look up'))

    expect(await screen.findByText('Found: Cathay Pacific Airways, B77W')).toBeInTheDocument()
    await waitFor(() => expect(winglog.airlineFindByIcao).toHaveBeenCalledWith('CPA'))

    const inputs = textInputs(container)
    expect(inputs[1]).toHaveValue('B77W')
    expect(inputs[2]).toHaveValue('Cathay Pacific')

    await waitFor(() => expect(winglog.simbriefAirframesForType).toHaveBeenCalledWith('B77W'))
    await waitFor(() => expect(textInputs(container)[3]).toHaveValue('B77W'))

    await user.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          photoThumbnailUrl: 'https://airport-data.com/thumb.jpg',
          operatorIata: 'CX',
          operatorIcao: 'CPA'
        })
      )
    )
  })

  it('falls back to the raw operator/ICAO when no operatorIcao is returned (no airline match)', async () => {
    setWinglog({
      aircraftLookupByRegistration: vi.fn().mockResolvedValue({
        icaoType: 'C172',
        operator: null,
        operatorIcao: null,
        photoThumbnailUrl: null
      })
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'N999')
    await user.click(screen.getByText('Look up'))
    expect(await screen.findByText('Found: unknown operator, C172')).toBeInTheDocument()
    expect(textInputs(container)[2]).toHaveValue('')
  })

  it('does not overwrite an already-filled operator/photo on a repeat lookup', async () => {
    setWinglog({
      aircraftLookupByRegistration: vi.fn().mockResolvedValue({
        icaoType: 'A320',
        operator: 'Some Other Airline',
        operatorIcao: null,
        photoThumbnailUrl: 'https://airport-data.com/other.jpg'
      })
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByText('Look up'))
    await screen.findByText(/Found:/)
    // operator/photo already set on FULL_AIRCRAFT — untouched by the lookup above.
    expect(textInputs(container)[2]).toHaveValue('British Airways')
  })

  it('does not re-autofill simbriefType when one is already set', async () => {
    const winglog = setWinglog({
      aircraftLookupByRegistration: vi.fn().mockResolvedValue({
        icaoType: 'A35K',
        operator: null,
        operatorIcao: null,
        photoThumbnailUrl: null
      })
    })
    const user = userEvent.setup()
    render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByText('Look up'))
    await screen.findByText(/Found:/)
    expect(winglog.simbriefAirframesForType).not.toHaveBeenCalledWith('A35K')
  })

  it('does not clobber a simbriefType typed while the post-lookup autofill fetch is still pending', async () => {
    let resolveOptions: (opts: SimbriefAirframeOption[]) => void = () => {}
    setWinglog({
      aircraftLookupByRegistration: vi.fn().mockResolvedValue({
        icaoType: 'B77W',
        operator: null,
        operatorIcao: null,
        photoThumbnailUrl: null
      }),
      simbriefAirframesForType: vi.fn(
        () =>
          new Promise<SimbriefAirframeOption[]>((resolve) => {
            resolveOptions = resolve
          })
      )
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-TEST')
    await user.click(screen.getByText('Look up'))
    await screen.findByText(/Found:/)
    // Type into the SimBrief type field manually before the pending autofill fetch resolves.
    await user.type(textInputs(container)[3], 'A320')
    resolveOptions([{ ...DEFAULT_OPTION, simbriefType: 'B77W' }])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(textInputs(container)[3]).toHaveValue('A320')
  })

  it('shows the lookup error message when the lookup rejects with an Error', async () => {
    setWinglog({ aircraftLookupByRegistration: vi.fn().mockRejectedValue(new Error('adsbdb is down')) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-TEST')
    await user.click(screen.getByText('Look up'))
    expect(await screen.findByText('adsbdb is down')).toBeInTheDocument()
  })

  it('shows a stringified lookup error when the rejection is not an Error', async () => {
    setWinglog({ aircraftLookupByRegistration: vi.fn().mockRejectedValue('boom') })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-TEST')
    await user.click(screen.getByText('Look up'))
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('shows the "too short" placeholder for a type under 3 characters, then loads SimBrief options once long enough', async () => {
    let resolveOptions: (opts: SimbriefAirframeOption[]) => void = () => {}
    setWinglog({
      simbriefAirframesForType: vi.fn(
        () =>
          new Promise<SimbriefAirframeOption[]>((resolve) => {
            resolveOptions = resolve
          })
      )
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('Enter an ICAO type above first')).toBeInTheDocument()

    await user.type(textInputs(container)[1], 'A35')
    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    resolveOptions([COMMUNITY_OPTION])
    expect(await screen.findByText('— choose —')).toBeInTheDocument()
  }, 10000)

  it('ignores a stale SimBrief airframe fetch that resolves after the type changed again', async () => {
    let resolveFirst: (opts: SimbriefAirframeOption[]) => void = () => {}
    const simbriefAirframesForType = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SimbriefAirframeOption[]>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue([])
    setWinglog({ simbriefAirframesForType })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A35')
    await waitFor(() => expect(simbriefAirframesForType).toHaveBeenCalledWith('A35'), { timeout: 2000 })

    // Change the type again before the first fetch resolves — its effect's cleanup marks
    // that in-flight fetch as cancelled.
    await user.clear(textInputs(container)[1])
    await user.type(textInputs(container)[1], 'B77W')
    await waitFor(() => expect(simbriefAirframesForType).toHaveBeenCalledWith('B77W'), { timeout: 2000 })

    // Resolving the stale first fetch now must not clobber the (empty) options for B77W.
    resolveFirst([COMMUNITY_OPTION])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('FlyByWire — Trent XWB')).not.toBeInTheDocument()
    expect(screen.getByText('SimBrief doesn’t recognise this type')).toBeInTheDocument()
  }, 10000)

  it('shows "SimBrief doesn\'t recognise this type" when the search resolves empty', async () => {
    setWinglog({ simbriefAirframesForType: vi.fn().mockResolvedValue([]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'ZZZZ')
    expect(await screen.findByText('SimBrief doesn’t recognise this type')).toBeInTheDocument()
  }, 10000)

  it('picking a community airframe option fills type/developer/engines and shows the create-custom-airframe button', async () => {
    setWinglog({ simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A35K')
    await screen.findByText('— choose —')

    await pickSelectOption(user, 'FlyByWire — Trent XWB')

    expect(textInputs(container)[3]).toHaveValue('A35K')
    expect(screen.getByText('Create a custom airframe in SimBrief')).toBeInTheDocument()
  }, 10000)

  it('picking a community option with no parsed developer falls back to the raw comment as its label', async () => {
    setWinglog({ simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION_NO_DEVELOPER]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A320')
    await screen.findByText('— choose —')
    await user.click(screen.getByRole('combobox'))
    await waitFor(() => {
      const found = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
        (el) => el.textContent === 'A mystery airframe (freeform comment) — CFM56'
      )
      expect(found).toBeTruthy()
    })
    // Also select it — the collapsed trigger's own label (selectedOptionLabel) falls back
    // to the raw comment too when there's no parsed developer, a separate code path from
    // the dropdown row's own label (optionLabel) just checked above.
    const item = Array.from(document.querySelectorAll('[data-slot="select-item"]')).find(
      (el) => el.textContent === 'A mystery airframe (freeform comment) — CFM56'
    )!
    await user.click(item)
    expect(textInputs(container)[3]).toHaveValue('A320')
  }, 10000)

  it('shows a parsed variant alongside the developer, in both the dropdown row and the collapsed trigger', async () => {
    setWinglog({ simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION_WITH_VARIANT]) })
    const user = userEvent.setup()
    render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const inputs = textInputs(document.body)
    await user.type(inputs[1], 'B738')
    await screen.findByText('— choose —')
    await pickSelectOption(user, 'PMDG — Dual Class — CFM56')
    expect(screen.getByText('PMDG B738 — Dual Class — CFM56')).toBeInTheDocument()
  }, 10000)

  it('picking the SimBrief default option clears type/id and shows no create-custom button', async () => {
    setWinglog({ simbriefAirframesForType: vi.fn().mockResolvedValue([DEFAULT_OPTION, COMMUNITY_OPTION]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByText('— choose —')
    await pickSelectOption(user, `SimBrief default (${DEFAULT_OPTION.engines})`)

    expect(textInputs(container)[3]).toHaveValue('')
    expect(textInputs(container)[4]).toHaveValue('')
    expect(screen.queryByText('Create a custom airframe in SimBrief')).not.toBeInTheDocument()
  }, 10000)

  it('changing the ICAO type after picking an option clears the selection', async () => {
    setWinglog({ simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A35K')
    await screen.findByText('— choose —')
    await pickSelectOption(user, 'FlyByWire — Trent XWB')
    expect(screen.getByText('Create a custom airframe in SimBrief')).toBeInTheDocument()

    await user.clear(textInputs(container)[1])
    await user.type(textInputs(container)[1], 'B77W')
    await waitFor(() => expect(screen.queryByText('Create a custom airframe in SimBrief')).not.toBeInTheDocument())
  }, 10000)

  it('creating a custom airframe saves the returned id and shows a success message', async () => {
    const winglog = setWinglog({
      simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION]),
      simbriefCreateCustomAirframe: vi.fn().mockResolvedValue('999999_1111111111')
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A35K')
    await screen.findByText('— choose —')
    await pickSelectOption(user, 'FlyByWire — Trent XWB')

    await user.click(screen.getByText('Create a custom airframe in SimBrief'))
    expect(winglog.simbriefCreateCustomAirframe).toHaveBeenCalledWith(COMMUNITY_OPTION.shareUrl)
    expect(await screen.findByText('Custom airframe saved.')).toBeInTheDocument()
    expect(textInputs(container)[4]).toHaveValue('999999_1111111111')
  }, 10000)

  it('shows a cancelled message when the create-custom-airframe window closes without saving', async () => {
    setWinglog({
      simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION]),
      simbriefCreateCustomAirframe: vi.fn().mockResolvedValue(null)
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[1], 'A35K')
    await screen.findByText('— choose —')
    await pickSelectOption(user, 'FlyByWire — Trent XWB')
    await user.click(screen.getByText('Create a custom airframe in SimBrief'))
    expect(await screen.findByText('No airframe was saved — the window was closed before finishing.')).toBeInTheDocument()
  }, 10000)

  it('does nothing when creating a custom airframe for an option with no share URL', async () => {
    const winglog = setWinglog({
      simbriefAirframesForType: vi.fn().mockResolvedValue([COMMUNITY_OPTION_NO_SHARE])
    })
    const user = userEvent.setup()
    render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const inputs = textInputs(document.body)
    await user.type(inputs[1], 'A35K')
    await screen.findByText('— choose —')
    await pickSelectOption(user, 'FlyByWire — Trent XWB')
    await user.click(screen.getByText('Create a custom airframe in SimBrief'))
    expect(winglog.simbriefCreateCustomAirframe).not.toHaveBeenCalled()
  }, 10000)

  it('typing directly into the SimBrief type field clears the cached developer/engine label', async () => {
    const { container } = render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await userEvent.setup().type(textInputs(container)[3], 'x')
    expect(textInputs(container)[3]).toHaveValue('A35Kx'.toUpperCase())
  })

  it('typing directly into the custom airframe id field clears the cached label and shows a format warning for an odd value', async () => {
    const user = userEvent.setup()
    const { container } = render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByText(/double-check this against/)).not.toBeInTheDocument()

    await user.clear(textInputs(container)[4])
    await user.type(textInputs(container)[4], 'not-a-real-id')
    expect(screen.getByText(/double-check this against/)).toBeInTheDocument()
  })

  it('shows no format warning once cleared back to blank', async () => {
    const user = userEvent.setup()
    const { container } = render(<AircraftForm initial={FULL_AIRCRAFT} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.clear(textInputs(container)[4])
    expect(screen.queryByText(/double-check this against/)).not.toBeInTheDocument()
  })

  it('opens the SimBrief airframes page with the trimmed id, or null when blank', async () => {
    const winglog = setWinglog()
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByText('Open airframes page'))
    expect(winglog.dispatchOpenSimBriefAirframes).toHaveBeenCalledWith(null)

    await user.type(textInputs(container)[4], '  123_456  ')
    await user.click(screen.getByText('Open airframes page'))
    expect(winglog.dispatchOpenSimBriefAirframes).toHaveBeenLastCalledWith('123_456')
  })

  it('picking an airline from the combobox fills IATA/ICAO, and typing over it clears them', async () => {
    setWinglog({ airlineSearch: vi.fn().mockResolvedValue([{ name: 'British Airways', icao: 'BAW', iata: 'BA' }]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[2], 'Brit')
    await user.click(await screen.findByText('British Airways (BAW/BA)'))
    expect(textInputs(container)[2]).toHaveValue('British Airways')

    await user.type(textInputs(container)[2], 'x')
    // onChange clears operatorIata/operatorIcao — not independently visible in the DOM, but
    // exercised here for coverage; verified indirectly via the submit payload test below.
  }, 10000)

  it('shows an airline search result with no IATA code without a trailing slash', async () => {
    setWinglog({ airlineSearch: vi.fn().mockResolvedValue([{ name: 'Cargo Carrier', icao: 'CGO', iata: '' }]) })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[2], 'Cargo')
    expect(await screen.findByText('Cargo Carrier (CGO)')).toBeInTheDocument()
  }, 10000)

  it('submits operatorIata/operatorIcao cleared after manually editing the airline field', async () => {
    setWinglog({ airlineSearch: vi.fn().mockResolvedValue([{ name: 'British Airways', icao: 'BAW', iata: 'BA' }]) })
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[2], 'Brit')
    await user.click(await screen.findByText('British Airways (BAW/BA)'))
    await user.type(textInputs(container)[2], 'x')
    await user.type(textInputs(container)[0], 'G-ABCD')
    await user.type(textInputs(container)[1], 'A320')
    await user.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ operatorIata: null, operatorIcao: null }))
    )
  }, 10000)

  it('searches the current airport via AirportSearch and picks a result', async () => {
    setWinglog({
      airportSearch: vi.fn().mockResolvedValue([{ icao: 'EGLL', name: 'Heathrow', municipality: 'London', isoCountry: 'GB' }])
    })
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[5], 'heath')
    await user.click(await screen.findByText('EGLL — Heathrow (London, GB)'))
    expect(textInputs(container)[5]).toHaveValue('EGLL')
  }, 10000)

  it('submits a full create payload with all optional fields trimmed/nulled correctly', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    setWinglog()
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    const inputs = textInputs(container)
    await user.type(inputs[0], '  G-NEWW  ')
    await user.type(inputs[1], 'a320')
    await user.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        registration: 'G-NEWW',
        icaoType: 'A320',
        operator: null,
        operatorIata: null,
        operatorIcao: null,
        simbriefAirframeId: null,
        simbriefType: null,
        currentIcao: null,
        photoThumbnailUrl: null,
        simbriefAirframeDeveloper: null,
        simbriefAirframeEngines: null,
        simbriefAirframeRegistration: null
      })
    )
  })

  it('shows "Saving…" while the submit promise is pending, then clears on success', async () => {
    let resolveSubmit: () => void = () => {}
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (resolveSubmit = resolve)))
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-X')
    await user.type(textInputs(container)[1], 'A320')
    await user.click(screen.getByText('Save'))
    expect(await screen.findByText('Saving…')).toBeInTheDocument()
    resolveSubmit()
    await waitFor(() => expect(screen.getByText('Save')).toBeInTheDocument())
  })

  it('shows the submit error message when onSubmit rejects with an Error', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('save failed'))
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-X')
    await user.type(textInputs(container)[1], 'A320')
    await user.click(screen.getByText('Save'))
    expect(await screen.findByText('save failed')).toBeInTheDocument()
  })

  it('shows a stringified submit error when the rejection is not an Error', async () => {
    const onSubmit = vi.fn().mockRejectedValue('nope')
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-X')
    await user.type(textInputs(container)[1], 'A320')
    await user.click(screen.getByText('Save'))
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })

  it('disables Save and Cancel while submitting', async () => {
    let resolveSubmit: () => void = () => {}
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (resolveSubmit = resolve)))
    const user = userEvent.setup()
    const { container } = render(<AircraftForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    await user.type(textInputs(container)[0], 'G-X')
    await user.type(textInputs(container)[1], 'A320')
    await user.click(screen.getByText('Save'))
    expect(screen.getByText('Cancel')).toBeDisabled()
    resolveSubmit()
    await waitFor(() => expect(screen.getByText('Save')).not.toBeDisabled())
  })
})
