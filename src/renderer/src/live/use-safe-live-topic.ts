/**
 * A live topic followed with every failure swallowed into the log: for the screens that must keep working when the live client cannot be
 * reached (a test without the preload, or the window closing). The value stays `initial` until main sends one.
 */
import { useEffect, useState } from 'react'
import type { LiveTopic, LiveTopics } from '@shared/live'
import { reportError } from '../report-error'
import { useLiveClient } from './LiveClient'

/**
 * @param topic The topic.
 * @param initial The value until the first answer.
 * @returns The topic's latest value.
 */
export function useSafeLiveTopic<T extends LiveTopic>(topic: T, initial: LiveTopics[T]): LiveTopics[T] {
  const client = useLiveClient()
  const [value, setValue] = useState<LiveTopics[T]>(initial)
  useEffect(() => {
    let current = true
    try {
      client.get(topic).then(
        (held) => {
          if (current && held) setValue(held)
        },
        (error: unknown) => reportError(`live topic ${topic}`, error)
      )
      const unsubscribe = client.subscribe(topic, setValue)
      return () => {
        current = false
        unsubscribe()
      }
    } catch (error) {
      reportError(`live topic ${topic} subscribe`, error)
      return undefined
    }
  }, [client, topic])
  return value
}
