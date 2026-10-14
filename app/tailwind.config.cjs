// Purpose: Project the theme's full CSS color values into the existing Tailwind pipeline.
/** @type {import('tailwindcss').Config} */

module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    fontFamily: {
      sans: ["var(--font-sans)"],
      mono: ["var(--font-mono)"],
      reading: ["var(--font-reading)"],
      studio: ["var(--font-studio)"],
    },
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontSize: Object.fromEntries(
        ["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl"].map((size) => [
          size,
          [`var(--text-${size})`, { lineHeight: `var(--leading-${size})` }],
        ]),
      ),
      lineHeight: {
        none: "var(--leading-none)",
        tight: "var(--leading-tight)",
        snug: "var(--leading-snug)",
        normal: "var(--leading-normal)",
      },
      letterSpacing: Object.fromEntries(
        [
          "tighter",
          "tight",
          "normal",
          "wide",
          "wider",
          "meta",
          "caps",
          "caps-wide",
        ].map((name) => [name, `var(--tracking-${name})`]),
      ),
      colors: {
        border: {
          DEFAULT:
            "color-mix(in oklab, var(--border) calc(<alpha-value> * 100%), transparent)",
          muted: "var(--surface-border-muted)",
          subtle: "var(--surface-border-subtle)",
          strong: "var(--surface-border-strong)",
          selected: "var(--surface-border-selected)",
        },
        input:
          "color-mix(in oklab, var(--input) calc(<alpha-value> * 100%), transparent)",
        ring: "color-mix(in oklab, var(--ring) calc(<alpha-value> * 100%), transparent)",
        background:
          "color-mix(in oklab, var(--background) calc(<alpha-value> * 100%), transparent)",
        foreground:
          "color-mix(in oklab, var(--foreground) calc(<alpha-value> * 100%), transparent)",
        primary: {
          DEFAULT:
            "color-mix(in oklab, var(--primary) calc(<alpha-value> * 100%), transparent)",
          hover:
            "color-mix(in oklab, var(--primary-hover) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--primary-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        secondary: {
          DEFAULT:
            "color-mix(in oklab, var(--secondary) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--secondary-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        destructive: {
          DEFAULT:
            "color-mix(in oklab, var(--destructive) calc(<alpha-value> * 100%), transparent)",
          hover:
            "color-mix(in oklab, var(--destructive-hover) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--destructive-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        muted: {
          DEFAULT:
            "color-mix(in oklab, var(--muted) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--muted-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        accent: {
          DEFAULT:
            "color-mix(in oklab, var(--accent) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--accent-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        popover: {
          DEFAULT:
            "color-mix(in oklab, var(--popover) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--popover-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        card: {
          DEFAULT:
            "color-mix(in oklab, var(--card) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--card-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        sidebar: {
          DEFAULT:
            "color-mix(in oklab, var(--sidebar-background) calc(<alpha-value> * 100%), transparent)",
          foreground:
            "color-mix(in oklab, var(--sidebar-foreground) calc(<alpha-value> * 100%), transparent)",
          primary:
            "color-mix(in oklab, var(--sidebar-primary) calc(<alpha-value> * 100%), transparent)",
          "primary-foreground":
            "color-mix(in oklab, var(--sidebar-primary-foreground) calc(<alpha-value> * 100%), transparent)",
          accent:
            "color-mix(in oklab, var(--sidebar-accent) calc(<alpha-value> * 100%), transparent)",
          "accent-foreground":
            "color-mix(in oklab, var(--sidebar-accent-foreground) calc(<alpha-value> * 100%), transparent)",
          border:
            "color-mix(in oklab, var(--sidebar-border) calc(<alpha-value> * 100%), transparent)",
          ring: "color-mix(in oklab, var(--sidebar-ring) calc(<alpha-value> * 100%), transparent)",
        },
        surface: {
          1: "color-mix(in oklab, var(--surface-1) calc(<alpha-value> * 100%), transparent)",
          2: "color-mix(in oklab, var(--surface-2) calc(<alpha-value> * 100%), transparent)",
          3: "color-mix(in oklab, var(--surface-3) calc(<alpha-value> * 100%), transparent)",
          "row-hover": "var(--surface-row-hover)",
          control: {
            DEFAULT: "var(--surface-control)",
            hover: "var(--surface-control-hover)",
            active: "var(--surface-control-active)",
          },
        },
        indicator: Object.fromEntries(
          [
            "blue",
            "orange",
            "teal",
            "cyan",
            "purple",
            "magenta",
            "amber",
            "green",
            "muted",
          ].map((name) => [
            name,
            `color-mix(in oklab, var(--indicator-${name}) calc(<alpha-value> * 100%), transparent)`,
          ]),
        ),
        glow: Object.fromEntries(
          ["accent", "positive", "negative"].map((name) => [
            name,
            `color-mix(in oklab, var(--glow-${name}) calc(<alpha-value> * 100%), transparent)`,
          ]),
        ),
        chart: {
          ...Object.fromEntries(
            [
              // The chart palette; the event calendar's today and selection highlights read it.
              "1",
              "2",
              "3",
              "4",
              "5",
              "grid",
              "text",
              "panel",
              "annotation-border",
              "annotation-fill",
              "annotation-text",
              "agent-annotation-fill",
              "agent-annotation-text",
              "agent-annotation-positive",
              "agent-annotation-negative",
              "agent-annotation-neutral",
            ].map((name) => [
              name,
              `color-mix(in oklab, var(--chart-${name}) calc(<alpha-value> * 100%), transparent)`,
            ]),
          ),
          "split-line": "var(--chart-split-line)",
        },
        up: "color-mix(in oklab, var(--up) calc(<alpha-value> * 100%), transparent)",
        down: "color-mix(in oklab, var(--down) calc(<alpha-value> * 100%), transparent)",
        unchanged:
          "color-mix(in oklab, var(--unchanged) calc(<alpha-value> * 100%), transparent)",
      },
      borderRadius: {
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      height: {
        control: "var(--control-h)",
        "control-xs": "var(--control-h-xs)",
        "control-sm": "var(--control-h-sm)",
        "control-lg": "var(--control-h-lg)",
      },
      width: {
        control: "var(--control-h)",
      },
      spacing: Object.fromEntries(
        ["xs", "sm", "md", "lg", "xl"].map((size) => [
          `icon-${size}`,
          `var(--icon-size-${size})`,
        ]),
      ),
      strokeWidth: Object.fromEntries(
        ["thin", "regular", "bold"].map((weight) => [
          `icon-${weight}`,
          `var(--icon-stroke-${weight})`,
        ]),
      ),
      minHeight: {
        "control-sm": "var(--control-h-sm)",
      },
      padding: {
        control: "var(--control-px)",
      },
      gap: {
        control: "var(--control-gap)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        widget: "var(--shadow-widget)",
        selected: "var(--shadow-selected)",
      },
      transitionDuration: {
        DEFAULT: "var(--duration-normal)",
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        DEFAULT: "var(--ease-default)",
        panel: "var(--ease-panel)",
        snappy: "var(--ease-snappy)",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
};
