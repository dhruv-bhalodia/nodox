/**
 * Re-exports inferShape and mergeShapes from the response interceptor.
 * This thin wrapper exists so jest-setup.js can import these functions
 * using a path relative to layer4/ rather than crossing multiple directories.
 */
export { inferShape, mergeShapes } from '../schema/response-interceptor.js'
