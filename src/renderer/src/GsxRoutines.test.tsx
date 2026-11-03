import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GsxRoutinesResult, WingLogApi } from '@shared/ipc'
import { allRoutines, routineServices, stageRoutine, type GsxRoutine } from '@shared/gsx-routines'
import type { GsxRoutineProgress } from '@shared/gsx-routine-progress'
import { GsxRoutines } from './GsxRoutines'

const OWN: GsxRoutine = {
  id: 'my-turnaround',
  name: 'A320 turnaround',
  stages: stageRoutine(['Cleaning', 'Catering', 'Refueling', 'Boarding']),
  answerGsxChoice: false,
  fuel: 'ask'
}

const RUNNING: GsxRoutineProgress = {
  routineId: 'builtin-fenix-departure',
  routineName: 'Departure',
  state: 'running',
  stage: 1,
  stageCount: 2,
  services: [
    { service: 'Catering', progress: 'running' },
    { service: 'Refueling', progress: 'asking' },
    { service: 'Boarding', progress: 'waiting' }
  ],
  note: { code: 'waiting-for-stage', services: ['Catering'] }
}

/** Installs a window.winglog with the routine calls, and returns the mocks and the way to push progress. */
function withWinglog(
  options: {
    routines?: GsxRoutine[]
    progress?: GsxRoutineProgress | null
    save?: GsxRoutinesResult
  } = {}
): {
  api: Record<string, ReturnType<typeof vi.fn>>
  push: (progress: GsxRoutineProgress | null) => void
} {
  let listener: (progress: GsxRoutineProgress | null) => void = () => {}
  const api = {
    gsxRoutineGet: vi.fn().mockResolvedValue(options.progress ?? null),
    onGsxRoutine: vi.fn((l: (progress: GsxRoutineProgress | null) => void) => {
      listener = l
      return () => {}
    }),
    gsxRoutineStart: vi.fn().mockResolvedValue(undefined),
    gsxRoutineCancel: vi.fn().mockResolvedValue(undefined),
    gsxRoutinesList: vi.fn().mockResolvedValue(allRoutines(options.routines ?? [])),
    gsxRoutinesSave: vi.fn().mockResolvedValue(options.save ?? { ok: true, routines: allRoutines([OWN]) }),
    gsxRoutinesDelete: vi.fn().mockResolvedValue(allRoutines([], ['builtin-arrival']))
  }
  window.winglog = api as unknown as WingLogApi
  return { api, push: (progress) => act(() => listener(progress)) }
}

/** Turns the Edit toggle on, then opens the named routine in the editor. */
async function editRoutine(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit', pressed: false }))
  await userEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }))
}

describe('GsxRoutines', () => {
  describe('the routine buttons', () => {
    it('offers the three built-in routines by name', async () => {
      withWinglog()
      render(<GsxRoutines canEdit />)
      for (const name of ['Departure', 'Arrival', 'Turnaround clean']) {
        expect(await screen.findByRole('button', { name })).toBeInTheDocument()
      }
    })

    it('lists the pilot’s own routines after them', async () => {
      withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      const buttons = await screen.findAllByRole('button', { name: /^(Departure|Arrival|Turnaround|A320)/ })
      expect(buttons.map((b) => b.textContent)).toEqual([
        'Departure',
        'Arrival',
        'Turnaround clean',
        'A320 turnaround'
      ])
    })

    it('starts a routine by its id', async () => {
      const { api } = withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      await userEvent.click(await screen.findByRole('button', { name: 'A320 turnaround' }))
      expect(api.gsxRoutineStart).toHaveBeenCalledWith('my-turnaround')
      await userEvent.click(screen.getByRole('button', { name: 'Arrival' }))
      expect(api.gsxRoutineStart).toHaveBeenCalledWith('builtin-arrival')
    })

    it('has no editing on a phone', async () => {
      withWinglog()
      render(<GsxRoutines canEdit={false} />)
      await screen.findByRole('button', { name: 'Arrival' })
      expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
      expect(screen.queryByRole('button', { name: 'New routine' })).toBeNull()
    })

    it('turns the routine buttons into edit buttons while Edit is on, and back off', async () => {
      const { api } = withWinglog()
      render(<GsxRoutines canEdit />)
      const toggle = await screen.findByRole('button', { name: 'Edit', pressed: false })
      await userEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: 'Edit Arrival' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Arrival' })).toBeNull()
      await userEvent.click(toggle)
      await userEvent.click(await screen.findByRole('button', { name: 'Arrival' }))
      expect(api.gsxRoutineStart).toHaveBeenCalledWith('builtin-arrival')
      expect(screen.queryByRole('button', { name: 'Edit Arrival' })).toBeNull()
    })

    it('lets a routine be edited while another runs, though it cannot be started', async () => {
      withWinglog({ progress: RUNNING })
      render(<GsxRoutines canEdit />)
      await screen.findByTestId('gsx-routine-progress')
      await userEvent.click(screen.getByRole('button', { name: 'Edit', pressed: false }))
      expect(screen.getByRole('button', { name: 'Edit Arrival' })).toBeEnabled()
    })
  })

  describe('the progress of a running routine', () => {
    it('shows the stage, each service, the status line and Cancel', async () => {
      withWinglog({ progress: RUNNING })
      render(<GsxRoutines canEdit />)
      const panel = await screen.findByTestId('gsx-routine-progress')
      expect(within(panel).getByText('Departure')).toBeInTheDocument()
      expect(within(panel).getByText('Stage 1 of 2')).toBeInTheDocument()
      expect(within(panel).getByText('Catering')).toBeInTheDocument()
      expect(within(panel).getByText('under way')).toBeInTheDocument()
      expect(within(panel).getByText('asking')).toBeInTheDocument()
      expect(within(panel).getByRole('status')).toHaveTextContent('Waiting for: Catering.')
      expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    })

    it('cancels through the live command, and holds the other buttons while it runs', async () => {
      const { api } = withWinglog({ progress: RUNNING })
      render(<GsxRoutines canEdit />)
      await screen.findByTestId('gsx-routine-progress')
      expect(screen.getByRole('button', { name: 'Arrival' })).toBeDisabled()
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(api.gsxRoutineCancel).toHaveBeenCalledTimes(1)
    })

    it('follows the topic as the routine goes on, and goes when it is cleared', async () => {
      const { push } = withWinglog()
      render(<GsxRoutines canEdit />)
      await screen.findByRole('button', { name: 'Arrival' })
      expect(screen.queryByTestId('gsx-routine-progress')).toBeNull()
      push(RUNNING)
      expect(await screen.findByTestId('gsx-routine-progress')).toBeInTheDocument()
      push({ ...RUNNING, note: { code: 'waiting-for-pilot', menu: 'Select refueling level' } })
      expect(await screen.findByText('Waiting for you: Select refueling level')).toBeInTheDocument()
      push(null)
      await waitFor(() => expect(screen.queryByTestId('gsx-routine-progress')).toBeNull())
    })

    it('says why a routine stopped, and offers no Cancel once it has', async () => {
      withWinglog({
        progress: { ...RUNNING, state: 'stopped', note: { code: 'stopped', reason: 'gsx-has-no-plan' } }
      })
      render(<GsxRoutines canEdit />)
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Routine stopped: GSX has no SimBrief plan. Use Reload SimBrief.'
      )
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Arrival' })).toBeEnabled()
    })

    it('words the data-entry hold with how far the fuel is from its target', async () => {
      withWinglog({ progress: { ...RUNNING, note: { code: 'waiting-for-fuel-entry', gapKg: 8_200 } } })
      render(<GsxRoutines canEdit />)
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Waiting for the fuel: 8200 kg off the target.'
      )
    })
  })

  describe('the editor', () => {
    it('opens an example for editing like any routine, with Save and Delete', async () => {
      withWinglog()
      render(<GsxRoutines canEdit />)
      await editRoutine('Arrival')
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Arrival')
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
      expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Jetway' })).toBeEnabled()
    })

    it('saves a change to an example under its own id, and the row shows the new name', async () => {
      const { api } = withWinglog()
      api.gsxRoutinesSave.mockResolvedValue({
        ok: true,
        routines: allRoutines([{ ...OWN, id: 'builtin-arrival', name: 'My arrival' }])
      })
      render(<GsxRoutines canEdit />)
      await editRoutine('Arrival')
      const dialog = await screen.findByRole('dialog')
      await userEvent.clear(within(dialog).getByLabelText('Name'))
      await userEvent.type(within(dialog).getByLabelText('Name'), 'My arrival')
      await userEvent.click(within(dialog).getByRole('button', { name: 'GPU' }))
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.gsxRoutinesSave).toHaveBeenCalledTimes(1))
      const saved = api.gsxRoutinesSave.mock.calls[0][0] as GsxRoutine
      expect(saved).toMatchObject({ id: 'builtin-arrival', name: 'My arrival' })
      expect(saved.builtIn).toBeUndefined()
      expect(routineServices(saved)).toEqual(['OperateJetways', 'Deboarding'])
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.getByRole('button', { name: 'Edit My arrival' })).toBeInTheDocument()
    })

    it('makes a copy of an example under a new id, named after it', async () => {
      withWinglog()
      render(<GsxRoutines canEdit />)
      await editRoutine('Arrival')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Duplicate' }))
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Arrival copy')
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
      expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull()
    })

    it('makes a new routine: name it, tick services, see the stages, save', async () => {
      const { api } = withWinglog()
      render(<GsxRoutines canEdit />)
      await userEvent.click(await screen.findByRole('button', { name: 'New routine' }))
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(within(dialog).getByText('Tick at least one service.')).toBeInTheDocument()

      await userEvent.clear(within(dialog).getByLabelText('Name'))
      await userEvent.type(within(dialog).getByLabelText('Name'), 'A320 turnaround')
      for (const name of ['Cleaning', 'Catering', 'Refueling', 'Boarding']) {
        await userEvent.click(within(dialog).getByRole('button', { name, pressed: false }))
      }
      expect(within(dialog).getByLabelText('What stage 3 waits for')).toHaveValue('Catering')

      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.gsxRoutinesSave).toHaveBeenCalledTimes(1))
      expect(api.gsxRoutinesSave).toHaveBeenCalledWith({
        id: expect.stringMatching(/^[A-Za-z0-9-]+$/),
        name: 'A320 turnaround',
        stages: OWN.stages,
        answerGsxChoice: false,
        fuel: 'ask'
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(await screen.findByRole('button', { name: 'A320 turnaround' })).toBeInTheDocument()
    })

    it('moves a service to another stage and changes what a stage waits for', async () => {
      const { api } = withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      await editRoutine('A320 turnaround')
      const dialog = await screen.findByRole('dialog')
      await userEvent.selectOptions(within(dialog).getByLabelText('Move Refueling to'), 'Stage 1')
      expect(within(dialog).getByLabelText('Move Refueling to')).toHaveValue('0')
      await userEvent.selectOptions(within(dialog).getByLabelText('What stage 2 waits for'), 'Starts at once')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.gsxRoutinesSave).toHaveBeenCalled())
      const saved = api.gsxRoutinesSave.mock.calls[0][0] as GsxRoutine
      expect(saved.stages[0].services).toEqual(['Cleaning', 'Refueling'])
      expect(saved.stages[1].startsWhen).toEqual([])
    })

    it('saves the two options', async () => {
      const { api } = withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      await editRoutine('A320 turnaround')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(
        within(within(dialog).getByRole('group', { name: "Answer GSX's own default for me" })).getByRole(
          'button',
          {
            name: 'Yes'
          }
        )
      )
      await userEvent.click(within(dialog).getByRole('button', { name: 'SimBrief block fuel' }))
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(api.gsxRoutinesSave).toHaveBeenCalled())
      expect(api.gsxRoutinesSave.mock.calls[0][0]).toMatchObject({
        answerGsxChoice: true,
        fuel: 'simbrief-block'
      })
    })

    it('shows why a save was refused, and keeps the dialog open', async () => {
      withWinglog({ routines: [OWN], save: { ok: false, reason: 'the name must be 1 to 40 characters' } })
      render(<GsxRoutines canEdit />)
      await editRoutine('A320 turnaround')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        "Couldn't save: the name must be 1 to 40 characters"
      )
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('asks before deleting one of the pilot’s own routines, then deletes it', async () => {
      const { api } = withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      await editRoutine('A320 turnaround')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      expect(api.gsxRoutinesDelete).not.toHaveBeenCalled()
      const confirmation = within(dialog).getByTestId('gsx-routine-delete-confirmation')
      expect(confirmation).toHaveTextContent('Delete “A320 turnaround”? This can’t be undone.')
      await userEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(api.gsxRoutinesDelete).toHaveBeenCalledWith('my-turnaround'))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'A320 turnaround' })).toBeNull()
    })

    it('deletes a routine that comes with WingLog the same way, and it leaves the row', async () => {
      const { api } = withWinglog()
      render(<GsxRoutines canEdit />)
      await editRoutine('Arrival')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      const confirmation = within(dialog).getByTestId('gsx-routine-delete-confirmation')
      expect(confirmation).toHaveTextContent('Delete “Arrival”? This can’t be undone.')
      await userEvent.click(within(confirmation).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(api.gsxRoutinesDelete).toHaveBeenCalledWith('builtin-arrival'))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Edit Arrival' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Edit Turnaround clean' })).toBeInTheDocument()
    })

    it('keeps the routine when the confirmation is cancelled, and goes back to the usual buttons', async () => {
      const { api } = withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      await editRoutine('A320 turnaround')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await userEvent.click(
        within(within(dialog).getByTestId('gsx-routine-delete-confirmation')).getByRole('button', {
          name: 'Cancel'
        })
      )
      expect(api.gsxRoutinesDelete).not.toHaveBeenCalled()
      expect(within(dialog).queryByTestId('gsx-routine-delete-confirmation')).toBeNull()
      expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })

    it('closes without saving', async () => {
      const { api } = withWinglog({ routines: [OWN] })
      render(<GsxRoutines canEdit />)
      await editRoutine('A320 turnaround')
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0])
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(api.gsxRoutinesSave).not.toHaveBeenCalled()
    })
  })
})
