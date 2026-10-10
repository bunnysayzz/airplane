// SPDX-License-Identifier: Apache-2.0
// EyeIcon - the views glyph for Post.Stat.
//
// panelui's Post.Stat takes an icon *component* (`icon={EyeIcon}`), not an
// element, and re-renders it with `filled` on toggle. panelui ships its own
// hugeicons-based set, which cannot be installed here, so this is a thin
// adapter over the team's icon stack (@expo/vector-icons/Ionicons). It honours
// the same contract: { size, color, filled }.
import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';

export interface EyeIconProps {
  size?: number;
  color?: string;
  filled?: boolean;
}

export function EyeIcon({ size = 17, color, filled = false }: EyeIconProps) {
  return (
    <Ionicons
      name={filled ? 'eye' : 'eye-outline'}
      size={size}
      color={color}
    />
  );
}
