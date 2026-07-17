import shopify from "@shopify/eslint-plugin";

const config = [
  { ignores: ["build/**", "node_modules/**", ".cache/**", "prisma/migrations/**"] },
  ...shopify.configs.typescript,
  ...shopify.configs.react,
  ...shopify.configs.node,
  ...shopify.configs.prettier,
  {
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],

      // This app uses the automatic JSX runtime (tsconfig "jsx": "react-jsx"),
      // so React does not need to be in scope.
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",

      // Rules aimed at Shopify's internal i18n conventions; this app renders
      // plain English copy directly, matching docs/design.md.
      "@shopify/jsx-no-hardcoded-content": "off",
      "@shopify/jsx-no-complex-expressions": "off",

      // ".server.ts" is a Remix naming convention, not a real extension.
      "import/extensions": "off",

      // Config keys below are dictated by third-party APIs (Shopify future
      // flags, Remix future flags) and cannot be renamed.
      "@typescript-eslint/naming-convention": "off",

      // Node 18.20+ (this app's minimum) ships fetch/Request/Response/Headers
      // as stable globals; Remix depends on them.
      "n/no-unsupported-features/node-builtins": "off",

      // Allow the `///` form for the one Vite ambient-types reference.
      "spaced-comment": ["error", "always", { markers: ["/"] }],
    },
  },
];

export default config;
