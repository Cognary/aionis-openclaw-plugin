"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

type RevealVariant = "lift" | "slide" | "scale";

type RevealProps = {
  children: ReactNode;
  delay?: number;
  className?: string;
  variant?: RevealVariant;
};

const variantMap: Record<RevealVariant, { hidden: { opacity: number; y?: number; x?: number; scale?: number; filter: string }; show: { opacity: number; y?: number; x?: number; scale?: number; filter: string } }> = {
  lift: {
    hidden: { opacity: 0, y: 24, filter: "blur(8px)" },
    show: { opacity: 1, y: 0, filter: "blur(0px)" },
  },
  slide: {
    hidden: { opacity: 0, x: -18, filter: "blur(6px)" },
    show: { opacity: 1, x: 0, filter: "blur(0px)" },
  },
  scale: {
    hidden: { opacity: 0, scale: 0.96, y: 12, filter: "blur(7px)" },
    show: { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" },
  },
};

export function Reveal({ children, delay = 0, className, variant = "lift" }: RevealProps) {
  return (
    <motion.div
      className={className}
      initial={variantMap[variant].hidden}
      whileInView={variantMap[variant].show}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.55, delay, ease: [0.2, 0.85, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
