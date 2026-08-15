import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "apps/**",
      "**/dist/**",
      "**/node_modules/**",
      // Build/test config files live outside the packages' tsconfig `include`,
      // so the typed project service cannot resolve them.
      "**/*.config.ts",
    ],
  },
  {
    files: ["packages/**/*.ts"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "max-lines": ["error", { "max": 300, "skipBlankLines": true, "skipComments": true }],
    },
  },
  {
    // The M1 proof is a standalone script, but it is the artefact a reader
    // trusts the most — it gets the same rails as packages/**, minus the file
    // size cap (one script, one story).
    files: ["examples/**/*.ts"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
