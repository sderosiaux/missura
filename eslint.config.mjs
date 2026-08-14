import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["apps/**", "**/dist/**", "**/node_modules/**"] },
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
