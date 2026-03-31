"use client";

import React from "react";
import styles from "./Button.module.css";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  isLoading?: boolean;
};

export function Button({
  variant = "primary",
  isLoading,
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
      className={[
        styles.button,
        variant === "primary" ? styles.primary : styles.secondary,
        className || "",
      ].join(" ")}
    >
      {isLoading ? (
        <span className={styles.inline}>
          <span className={styles.spinner} aria-hidden="true" />
          <span>{typeof children === "string" ? `${children}…` : children}</span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}

