import { register } from 'node:module';

/* Later hooks run first: register after the TS loader to rewrite its emitted JavaScript. */
register('./hooks.js', import.meta.url);
