"use client";

import React from "react";
import styles from "./Button.module.css";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  isLoading?: boolean;
  /** 로딩 중에 표시할 텍스트. 지정하지 않으면 children 끝에 "…"를 붙인다. */
  loadingLabel?: string;
};

export function Button({
  variant = "primary",
  isLoading,
  loadingLabel,
  disabled,
  children,
  className,
  ...rest
}: Props) {
  const isDisabled = disabled || isLoading;
  return (
    <button
      {...rest}
      disabled={isDisabled}
      data-loading={isLoading ? "true" : undefined}
      aria-busy={isLoading ? true : undefined}
      className={[
        styles.button,
        variant === "primary" ? styles.primary : styles.secondary,
        className || "",
      ].join(" ")}
    >
      {isLoading ? (
        <span className={styles.inline}>
          <span className={styles.spinner} aria-hidden="true" />
          <span>
            {loadingLabel ??
              (typeof children === "string" ? `${children}…` : children)}
          </span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}

