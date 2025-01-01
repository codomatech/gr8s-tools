import globals from "globals";
import pluginJs from "@eslint/js";


export default [
  {
      files: ["src/main.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      }
    }
  },
  {
      files: ["src/s3s-crawl-assistant.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      }
    }
  },
  pluginJs.configs.recommended,
];
