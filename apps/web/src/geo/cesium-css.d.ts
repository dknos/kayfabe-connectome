// Vite resolves `.css` imports to a side-effect module; TypeScript needs to be
// told so the engine can pull in Cesium's widget stylesheet inside its dynamic
// import (that stylesheet is what sizes the canvas to its container).
declare module "*.css";
