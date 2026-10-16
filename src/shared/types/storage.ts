/** How much room the drive WingLog keeps its data on has left, and whether saving is failing. */
export interface StorageStatus {
  /** Free space for this user, in bytes; null when it can't be read. */
  freeBytes: number | null
  /** 'low' under 5 GB, 'critical' under 1 GB: flight data is at risk. */
  level: 'ok' | 'low' | 'critical'
  /** Saving the flight's track is failing right now (a full disk): points are held in memory until it works. */
  saveFailing: boolean
}
