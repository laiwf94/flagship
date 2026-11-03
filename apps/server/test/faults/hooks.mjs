// Lets `node --experimental-transform-types` run the server straight from its
// TypeScript sources, so the fault suite can SIGKILL real server processes
// without a build step. Sources import siblings as `./x.js`; when that file
// doesn't exist, resolve the `.ts` file next to it instead.
import { registerHooks } from 'node:module';

if (typeof registerHooks !== 'function') {
  throw new Error('the fault suite needs Node 22.15 or later (module.registerHooks)');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && relative && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
