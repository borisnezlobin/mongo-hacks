import { memo } from 'react';
import { Image, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { colors, radii } from '../constants/theme';
import { identiconFor } from '../lib/identicon';
import { useAvatarUri } from '../state/hooks';
import type { PersonRecord } from '../state/reducer';

interface AvatarProps {
  person?: PersonRecord;
  /** Falls back to the person id when the voiceprint has not been assigned yet. */
  seed?: string;
  size?: number;
  /** Transcript rows use rounded squares, the way Slack does. */
  shape?: 'circle' | 'rounded';
}

/**
 * The picture is looked up by person id from the one place pictures live. It used to be
 * copied onto the person record as well, and a person the naming sheet created from
 * scratch was built without that field — so naming a face lost its photo.
 */
export const Avatar = memo(function Avatar({ person, seed, size = 40, shape = 'circle' }: AvatarProps) {
  const uri = useAvatarUri(person?._id);
  const identiconSeed = person?.voiceprint_id ?? seed ?? person?._id ?? 'unknown';
  const { background, ink, cells } = identiconFor(identiconSeed);
  const cornerRadius = shape === 'circle' ? size / 2 : size * 0.22;

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: cornerRadius, backgroundColor: colors.canvasSunken }}
      />
    );
  }

  const grid = 5;
  const padding = size * 0.16;
  const cell = (size - padding * 2) / grid;
  const dot = cell * 0.62;

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Rect x={0} y={0} width={size} height={size} rx={cornerRadius} fill={background} />
        {cells.map((on, index) => {
          if (!on) return null;
          const row = Math.floor(index / grid);
          const column = index % grid;
          return (
            <Rect
              key={index}
              x={padding + column * cell + (cell - dot) / 2}
              y={padding + row * cell + (cell - dot) / 2}
              width={dot}
              height={dot}
              rx={dot * 0.3}
              fill={ink}
              opacity={0.9}
            />
          );
        })}
      </Svg>
    </View>
  );
});
