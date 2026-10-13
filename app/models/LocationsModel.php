<?php

/**
 * Class LocationsModel
 * 
 * Manages plant locations
 */ 
class LocationsModel extends \Asatru\Database\Model {
    const MAP_WIDTH = 1000;
    const MAP_MIN_HEIGHT = 300;
    const MAP_MAX_HEIGHT = 2000;
    const MAP_DEFAULT_HEIGHT = 600;
    const MAP_MAX_SHAPES = 200;
    const MAP_MAX_LABEL_LENGTH = 60;

    public static $map_shape_types = ['bed', 'lawn', 'path', 'water', 'structure'];

    /**
     * @param $only_active
     * @return mixed
     * @throws \Exception
     */
    public static function getAll($only_active = true)
    {
        try {
            if ($only_active) {
                return static::raw('SELECT * FROM `@THIS` WHERE active = 1 ORDER BY name ASC');
            } else {
                return static::raw('SELECT * FROM `@THIS` ORDER BY name ASC');
            }
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $only_active
     * @param $paginate
     * @param $limit
     */
    public static function getPaginated($only_active = true, $paginate = null, $limit = null)
    {
        try {
            $limit = ((is_numeric($limit) && ($limit > 0)) ? 'LIMIT ' . $limit : '');

            if ($paginate === null) {
                if ($only_active) {
                    return static::raw('SELECT * FROM `@THIS` WHERE active = 1 ORDER BY id ASC ' . $limit);
                } else {
                    return static::raw('SELECT * FROM `@THIS` ORDER BY id ASC ' . $limit);
                }
            } else {
                if ($only_active) {
                    return static::raw('SELECT * FROM `@THIS` WHERE active = 1 AND id >= ? ORDER BY id ASC ' . $limit, [$paginate]);
                } else {
                    return static::raw('SELECT * FROM `@THIS` WHERE id >= ? ORDER BY id ASC ' . $limit, [$paginate]);
                }
            }
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return string
     * @throws \Exception
     */
    public static function getNameById($id)
    {
        try {
            return static::raw('SELECT * FROM `@THIS` WHERE id = ? LIMIT 1', [$id])->first()?->get('name');
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @return int
     * @throws \Exception
     */
    public static function getCount()
    {
        try {
            return static::raw('SELECT COUNT(*) as count FROM `@THIS`')->first()->get('count');
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return mixed
     * @throws \Exception
     */
    public static function getLocationById($id)
    {
        try {
            return static::raw('SELECT * FROM `@THIS` WHERE id = ?', [$id])->first();
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $name
     * @return void
     * @throws \Exception
     */
    public static function addLocation($name)
    {
        try {
            static::raw('INSERT INTO `@THIS` (name) VALUES(?)', [
                $name
            ]);
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @param $name
     * @param $active
     * @return void
     * @throws \Exception
     */
    public static function editLocation($id, $name, $active)
    {
        try {
            static::raw('UPDATE `@THIS` SET name = ?, active = ? WHERE id = ?', [
                $name, $active, $id
            ]);
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return void
     * @throws \Exception
     */
    public static function setPhoto($id)
    {
        try {
            if ((!isset($_FILES['photo'])) || ($_FILES['photo']['error'] !== UPLOAD_ERR_OK)) {
                throw new \Exception('No image provided');
            }

            static::clearPhoto($id);

            $file_ext = UtilsModule::getImageExt($_FILES['photo']['tmp_name']);

            if ($file_ext === null) {
                throw new \Exception('File is not a valid image');
            }

            $file_name = md5(random_bytes(55) . date('Y-m-d H:i:s'));

            move_uploaded_file($_FILES['photo']['tmp_name'], public_path('/img/' . $file_name . '.' . $file_ext));

            if (!UtilsModule::createThumbFile(public_path('/img/' . $file_name . '.' . $file_ext), UtilsModule::getImageType($file_ext, public_path('/img/' . $file_name)), public_path('/img/' . $file_name), $file_ext)) {
                throw new \Exception('createThumbFile failed');
            }

            $fullFileName = $file_name . '_thumb.' . $file_ext;

            static::raw('UPDATE `@THIS` SET icon = ? WHERE id = ?', [$fullFileName, $id]);
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return void
     * @throws \Exception
     */
    public static function clearPhoto($id)
    {
        try {
            $item = static::raw('SELECT * FROM `@THIS` WHERE id = ?', [$id])->first();
            if (!$item) {
                throw new \Exception('Item not found: ' . $id);
            }

            if ($item->get('icon')) {
                $thumb_photo = $item->get('icon');
                $full_photo = str_replace('_thumb', '', $item->get('icon'));

                if (file_exists(public_path() . '/img/' . $thumb_photo)) {
                    unlink(public_path() . '/img/' . $thumb_photo);
                }

                if (file_exists(public_path() . '/img/' . $full_photo)) {
                    unlink(public_path() . '/img/' . $full_photo);
                }

                static::raw('UPDATE `@THIS` SET icon = NULL WHERE id = ?', [$id]);
            }
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @param $notes
     * @return void
     * @throws \Exception
     */
    public static function saveNotes($id, $notes)
    {
        try {
            static::raw('UPDATE `@THIS` SET notes = ? WHERE id = ?', [
                $notes, $id
            ]);
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @param $target
     * @return void
     * @throws \Exception
     */
    public static function removeLocation($id, $target)
    {
        try {
            if ((static::getCount() <= 1) && (PlantsModel::getPlantCount($id))) {
                throw new \Exception(__('app.error_room_not_empty'));
            }

            PlantsModel::migratePlants($id, $target);

            static::clearPhoto($id);
            static::clearMapBackground($id);

            static::raw('DELETE FROM `@THIS` WHERE id = ?', [$id]);
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return array
     * @throws \Exception
     */
    public static function getMap($id)
    {
        try {
            $item = static::raw('SELECT * FROM `@THIS` WHERE id = ?', [$id])->first();
            if (!$item) {
                throw new \Exception('Item not found: ' . $id);
            }

            $data = null;
            if (is_string($item->get('map_data'))) {
                $data = json_decode($item->get('map_data'), true);
            }

            $map = static::sanitizeMap($id, $data);
            $map['bg'] = ((is_array($data)) && (isset($data['bg'])) && (is_string($data['bg'])) && (preg_match('/^[a-f0-9]{32}\.(png|jpg|gif)$/', $data['bg']) === 1)) ? $data['bg'] : null;

            return $map;
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @param $data
     * @return array
     * @throws \Exception
     */
    public static function saveMap($id, $data)
    {
        try {
            $current = static::getMap($id);

            $map = static::sanitizeMap($id, $data);
            $map['bg'] = $current['bg'];

            static::raw('UPDATE `@THIS` SET map_data = ? WHERE id = ?', [json_encode($map), $id]);

            return $map;
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * Reduce map data to known fields with valid values. Pins of plants
     * that are not in the location anymore are dropped.
     * 
     * @param $id
     * @param $data
     * @return array
     * @throws \Exception
     */
    private static function sanitizeMap($id, $data)
    {
        try {
            $map = [
                'w' => self::MAP_WIDTH,
                'h' => self::MAP_DEFAULT_HEIGHT,
                'bg' => null,
                'shapes' => [],
                'pins' => []
            ];

            if (!is_array($data)) {
                return $map;
            }

            if ((isset($data['h'])) && (is_numeric($data['h']))) {
                $map['h'] = (int)max(self::MAP_MIN_HEIGHT, min(self::MAP_MAX_HEIGHT, $data['h']));
            }

            $clamp = function($value, $max) {
                return round(max(0, min($max, (is_numeric($value)) ? (float)$value : 0)), 1);
            };

            if ((isset($data['shapes'])) && (is_array($data['shapes']))) {
                foreach (array_slice($data['shapes'], 0, self::MAP_MAX_SHAPES) as $shape) {
                    if (!is_array($shape)) {
                        continue;
                    }

                    $type = $shape['type'] ?? null;
                    if (!in_array($type, static::$map_shape_types, true)) {
                        $type = static::$map_shape_types[0];
                    }

                    $label = (isset($shape['label']) && is_string($shape['label'])) ? trim($shape['label']) : '';

                    $width = max(10, $clamp($shape['w'] ?? 0, $map['w']));
                    $height = max(10, $clamp($shape['h'] ?? 0, $map['h']));

                    $map['shapes'][] = [
                        'type' => $type,
                        'round' => !empty($shape['round']),
                        'x' => $clamp($shape['x'] ?? 0, $map['w'] - $width),
                        'y' => $clamp($shape['y'] ?? 0, $map['h'] - $height),
                        'w' => $width,
                        'h' => $height,
                        'label' => mb_substr($label, 0, self::MAP_MAX_LABEL_LENGTH)
                    ];
                }
            }

            if ((isset($data['pins'])) && (is_array($data['pins']))) {
                $plants = [];
                foreach (PlantsModel::raw('SELECT id FROM `@THIS` WHERE location = ? AND history = 0', [$id]) as $plant) {
                    $plants[] = (int)$plant->get('id');
                }

                $placed = [];
                foreach ($data['pins'] as $pin) {
                    if ((!is_array($pin)) || (!isset($pin['plant'])) || (!is_numeric($pin['plant']))) {
                        continue;
                    }

                    $plant = (int)$pin['plant'];
                    if ((!in_array($plant, $plants, true)) || (in_array($plant, $placed, true))) {
                        continue;
                    }

                    $placed[] = $plant;

                    $map['pins'][] = [
                        'plant' => $plant,
                        'x' => $clamp($pin['x'] ?? 0, $map['w']),
                        'y' => $clamp($pin['y'] ?? 0, $map['h'])
                    ];
                }
            }

            return $map;
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return string
     * @throws \Exception
     */
    public static function setMapBackground($id)
    {
        try {
            if ((!isset($_FILES['background'])) || ($_FILES['background']['error'] !== UPLOAD_ERR_OK)) {
                throw new \Exception('No image provided');
            }

            $file_ext = UtilsModule::getImageExt($_FILES['background']['tmp_name']);

            if ($file_ext === null) {
                throw new \Exception('File is not a valid image');
            }

            static::clearMapBackground($id);

            $map = static::getMap($id);

            $file_name = md5(random_bytes(55) . date('Y-m-d H:i:s')) . '.' . $file_ext;

            move_uploaded_file($_FILES['background']['tmp_name'], public_path('/img/' . $file_name));

            $map['bg'] = $file_name;

            static::raw('UPDATE `@THIS` SET map_data = ? WHERE id = ?', [json_encode($map), $id]);

            return $file_name;
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return void
     * @throws \Exception
     */
    public static function clearMapBackground($id)
    {
        try {
            $map = static::getMap($id);

            if ($map['bg'] !== null) {
                if (file_exists(public_path('/img/' . $map['bg']))) {
                    unlink(public_path('/img/' . $map['bg']));
                }

                $map['bg'] = null;

                static::raw('UPDATE `@THIS` SET map_data = ? WHERE id = ?', [json_encode($map), $id]);
            }
        } catch (\Exception $e) {
            throw $e;
        }
    }

    /**
     * @param $id
     * @return bool
     * @throws \Exception
     */
    public static function isActive($id)
    {
        try {
            $data = static::raw('SELECT * FROM `@THIS` WHERE id = ? AND active = 1', [$id])->first();
            return $data !== null;
        } catch (\Exception $e) {
            throw $e;
        }
    }
}