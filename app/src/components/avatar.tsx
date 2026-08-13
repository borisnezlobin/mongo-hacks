import { Image, View } from 'react-native';
import Svg, { Circle, Rect } from 'react-native-svg';
import { colors, radii } from '../constants/theme';
import { identiconFor } from '../lib/identicon';
import type { PersonRecord } from '../lib/store';

interface AvatarProps {
  person?: PersonRecord;
  /** Falls back to the person id when the voiceprint has not been assigned yet. */
  seed?: string;
  size?: number;
}

export function Avatar({ person, seed, size = 40 }: AvatarProps) {
  const identiconSeed = person?.voiceprint_id ?? seed ?? person?._id ?? 'unknown';
  const { background, ink, cells } = identiconFor(identiconSeed);

  if (person?.avatar_uri) {
    return (
      <Image
        source={{ uri: person.avatar_uri }}
        style={{ width: size, height: size, borderRadius: radii.pill, backgroundColor: colors.canvasSunken }}
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
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={background} />
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
}
