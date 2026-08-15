import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "apps/**",
      // Standalone demo script: no tsconfig project, not a workspace package,
      // never imported by packages/**. The strict rails stay on packages/**.
      "examples/**",
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
);
