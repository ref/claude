export type Window = {
  /** Percent of the window used, as the last API response reported it */
  percent: number
  /** When the window resets, ms since the epoch; null when unknown */
  resetsAtMs: number | null
}

export type Snapshot = {
  /** The 7-day window; null when the engine has no reading (API key, or before the first response) */
  week: Window | null
  /** The 5-hour window; null when the engine has no reading */
  session: Window | null
  /** 1..7: which day of the 7-day window we are in */
  day: number
  /** Percent a paced project may have used by now */
  threshold: number
  /** week.percent > threshold */
  isOver: boolean
  /** Daily share of the week, from the plugin's settings */
  dailyPercent: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-pacer': {
      snapshot: Snapshot | null
    }
  }
}
