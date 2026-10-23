import { describe, expect, it } from 'vitest'
import { describeError } from './describe-error'

describe('describeError', () => {
  it('gives the name and the message', () => {
    expect(describeError(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
  })

  it('gives the name alone for an error with no message, as an AggregateError from a failed connection has', () => {
    expect(describeError(new AggregateError([new Error('ECONNREFUSED')]))).toBe('AggregateError')
  })

  it('writes anything else out as text', () => {
    expect(describeError('timed out')).toBe('timed out')
    expect(describeError(undefined)).toBe('undefined')
  })
})
