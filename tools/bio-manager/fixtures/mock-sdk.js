/**
 * Stand-in for https://da.live/nx/utils/sdk.js.
 *
 * fixtures/preview.html remaps the SDK's absolute URL to this file with an
 * import map, so the real bio-manager.js runs unmodified against it. Set
 * `?plugin=1` to get the library-plugin surface (an `actions` object, so the
 * roster grows its Insert button) instead of the fullscreen app surface.
 */

/* eslint-disable no-console */

const params = new URLSearchParams(window.location.search);
const asPlugin = params.get('plugin') === '1';

const actions = {
  sendText: (text) => console.log('[mock] sendText', text),
  sendHTML: (html) => console.log('[mock] sendHTML', html),
  closeLibrary: () => console.log('[mock] closeLibrary'),
};

// `view` is the real discriminator: DA's library palette posts 'edit', the
// fullscreen app host does not. `actions` is always present either way,
// exactly as the live SDK behaves.
export default Promise.resolve({
  context: {
    view: asPlugin ? 'edit' : 'app',
    org: 'aemgdc',
    site: 'aemdev',
    path: asPlugin ? '/en/meetups/2026-10-berlin-meetup' : '/',
  },
  token: 'mock-token',
  actions,
});
