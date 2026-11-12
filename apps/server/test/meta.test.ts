import { describe, expect, it } from 'vitest'
import { APP_NAME, appInfo } from '../src/meta.js'

describe('appInfo', () => {
  it('reports the app name with the default version', () => {
    expect(appInfo()).toEqual({ name: APP_NAME, version: '0.0.0' })
  })

  it('reports a supplied version', () => {
    expect(appInfo('1.2.3').version).toBe('1.2.3')
  })
})
