import * as React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

// Everything the window UI Kit exports, plus the React runtime needed to render
// it from a plain HTML page. Served to sandboxed pages as one IIFE bundle.
export * from './index';
export { React, createRoot, hydrateRoot };
