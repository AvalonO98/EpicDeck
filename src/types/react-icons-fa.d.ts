// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, EpicDeck Contributors

// `react-icons` is installed here without any of its `.d.ts` files, so every
// `import ... from "react-icons/fa"` was an implicit `any` and `tsc --noEmit`
// reported TS7016 in five files (审计 5.2). tsconfig `paths` points the
// specifier at this file rather than at the package, which keeps the mapping
// stable whether or not the installed copy happens to ship types.
//
// Only the icons actually imported are declared: a typo in an icon name then
// fails the typecheck instead of silently rendering nothing at runtime.
import type { ComponentType, SVGAttributes } from "react";

export type IconType = ComponentType<
  SVGAttributes<SVGElement> & {
    size?: string | number;
    color?: string;
    title?: string;
  }
>;

export const FaArrowLeft: IconType;
export const FaChevronLeft: IconType;
export const FaChevronRight: IconType;
export const FaClock: IconType;
export const FaCog: IconType;
export const FaDownload: IconType;
export const FaExclamationTriangle: IconType;
export const FaGamepad: IconType;
export const FaPlay: IconType;
export const FaRedo: IconType;
export const FaSearch: IconType;
export const FaSteamSymbol: IconType;
export const FaThLarge: IconType;
export const FaTrash: IconType;
