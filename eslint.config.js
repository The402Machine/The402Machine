import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
	{
		ignores: ["dist/**", "coverage/**", "node_modules/**", "eslint.config.js"],
	},
	{
		files: ["src/**/*.ts", "test/**/*.ts"],
		extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }],
		},
	},
);
