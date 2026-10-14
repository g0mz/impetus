import { describe, expect, it } from 'vitest';
import { mapFreeExerciseDbMuscle, mapMuscleLists } from '../../src/domain/training/muscles.ts';
import { fromFreeExercise, parsePtbrCsv } from '../../src/seeds/exercises.ts';
import { portionFoodName, portionLabel } from '../../src/seeds/portions.ts';
import { isPreparedTaco } from '../../src/seeds/taco.ts';

describe('mapeamento de músculos do free-exercise-db', () => {
  it('mapeia nomes diretos', () => {
    const ex = { name: 'X', force: 'push' };
    expect(mapFreeExerciseDbMuscle('quadriceps', ex)).toBe('quads');
    expect(mapFreeExerciseDbMuscle('middle back', ex)).toBe('upper_back');
    expect(mapFreeExerciseDbMuscle('abdominals', ex)).toBe('abs');
    expect(mapFreeExerciseDbMuscle('desconhecido', ex)).toBeNull();
  });

  it('infere a cabeça do deltoide pelo exercício', () => {
    expect(mapFreeExerciseDbMuscle('shoulders', { name: 'Side Lateral Raise', force: 'push' })).toBe(
      'side_delts',
    );
    expect(mapFreeExerciseDbMuscle('shoulders', { name: 'Face Pull', force: 'pull' })).toBe('rear_delts');
    expect(mapFreeExerciseDbMuscle('shoulders', { name: 'Dumbbell Shoulder Press', force: 'push' })).toBe(
      'front_delts',
    );
    expect(mapFreeExerciseDbMuscle('shoulders', { name: 'Some Row', force: 'pull' })).toBe('rear_delts');
  });

  it('não repete em secundários o que já é primário', () => {
    expect(
      mapMuscleLists(['quadriceps'], ['quadriceps', 'glutes'], { name: 'Squat', force: 'push' }),
    ).toEqual({
      primary: ['quads'],
      secondary: ['glutes'],
    });
  });

  it('converte um registro do free-exercise-db', () => {
    const e = fromFreeExercise({
      id: 'Dumbbell_Bench_Press',
      name: 'Dumbbell Bench Press',
      force: 'push',
      mechanic: 'compound',
      equipment: 'dumbbell',
      category: 'strength',
      primaryMuscles: ['chest'],
      secondaryMuscles: ['shoulders', 'triceps'],
    });
    expect(e).toMatchObject({
      name_en: 'Dumbbell Bench Press',
      equipment: 'dumbbell',
      load_kind: 'per_hand',
      is_compound: true,
      primary_muscles: ['chest'],
      secondary_muscles: ['front_delts', 'triceps'],
      source: 'free-exercise-db',
    });
  });
});

describe('validação do exercises_ptbr.csv', () => {
  const header =
    'source_id,name_pt,aliases,category,equipment,load_kind,is_compound,increment_kg,primary_muscles,secondary_muscles\n';
  const known = new Set(['A']);

  it('aceita uma linha válida', () => {
    const rows = parsePtbrCsv(
      `${header}A,Supino reto,supino|sup reto,strength,barbell,total,1,2.5,chest,triceps\n`,
      known,
    );
    expect(rows[0]).toMatchObject({ source_id: 'A', aliases: ['supino', 'sup reto'], increment_kg: 2.5 });
  });

  it('rejeita músculo fora do vocabulário, source_id desconhecido e apelido repetido', () => {
    expect(() => parsePtbrCsv(`${header}A,Xis,,strength,barbell,total,1,,peito,\n`, known)).toThrow(
      /linha 2/,
    );
    expect(() => parsePtbrCsv(`${header}B,Xis,,strength,barbell,total,1,,chest,\n`, known)).toThrow(
      /não existe/,
    );
    expect(() =>
      parsePtbrCsv(
        `${header}A,Supino,sup,strength,barbell,total,1,,chest,\n,Crucifixo,Sup,strength,dumbbell,per_hand,0,,chest,\n`,
        known,
      ),
    ).toThrow(/já usado/);
  });
});

describe('TACO e IBGE', () => {
  it('detecta alimento preparado pelo nome', () => {
    expect(isPreparedTaco('Arroz, tipo 1, cozido')).toBe(true);
    expect(isPreparedTaco('Frango, peito, sem pele, grelhado')).toBe(true);
    expect(isPreparedTaco('Batata, frita, tipo chips, industrializada')).toBe(true);
    expect(isPreparedTaco('Arroz carreteiro', '13')).toBe(true); // categoria "Alimentos preparados"
    expect(isPreparedTaco('Arroz, tipo 1, cru', '1')).toBe(false);
    expect(isPreparedTaco('Banana, prata, crua')).toBe(false);
  });

  it('monta rótulo e nome da medida caseira', () => {
    expect(
      portionLabel({ medida: 'Colher de sopa', referencia: 'Arroz cozido - colher de sopa cheia' }),
    ).toBe('colher de sopa cheia');
    expect(portionLabel({ medida: 'Copo americano', referencia: 'Copo americano' })).toBe('copo americano');
    expect(portionFoodName({ alimento: 'Ovo de galinha', preparo: 'Frito(a)' })).toBe(
      'Ovo de galinha — frito(a)',
    );
    expect(portionFoodName({ alimento: 'Arroz integral', preparo: 'Não se aplica' })).toBe('Arroz integral');
  });
});
