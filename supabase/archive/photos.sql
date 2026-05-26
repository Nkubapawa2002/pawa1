-- =====================================================
-- Pawa Bus Cargo - Bus photo mapping
-- =====================================================
-- BEFORE running this SQL:
--   1. In the Supabase dashboard go to Storage > New bucket
--      Name:   bus-photos
--      Public: YES (so the website can show images without signed URLs)
--   2. Open the bucket and upload all 10 jpg files from /bus web/data/
--      (drag and drop). Keep their original filenames.
--   3. Run this file in the SQL editor.
-- =====================================================

update buses set photo_path = 'aleksey-cherenkevich-ydleUv2q2Y4-unsplash.jpg',
                 about = 'Premium long-distance coach with reclining seats and on-board cargo hold.'
 where id = 'BUS001';

update buses set photo_path = 'elizabeth-lies-LUP8Tnwy7Ro-unsplash.jpg',
                 about = 'Daily express to Arusha, Dodoma, Mtwara, Tanga and Morogoro.'
 where id = 'BUS002';

update buses set photo_path = 'habib-ilmi-nTwn_5qYWgw-unsplash.jpg',
                 about = 'Trusted northern circuit operator (Dar – Arusha – Kilimanjaro).'
 where id = 'BUS003';

update buses set photo_path = 'hardial-aujla-rJ4tFb4F-DE-unsplash.jpg',
                 about = 'Cross-border-grade coaches serving the northern corridor.'
 where id = 'BUS004';

update buses set photo_path = 'jalal-kelink-ugzSzSG7CFA-unsplash.jpg',
                 about = 'Central Tanzania express — Dodoma, Singida, Tabora.'
 where id = 'BUS005';

update buses set photo_path = 'jonas-allert-IU8lP4p-LEY-unsplash.jpg',
                 about = 'High-class southern highlands coaches with overnight service.'
 where id = 'BUS006';

update buses set photo_path = 'jonathan-borba-EwoyDPlT_H0-unsplash.jpg',
                 about = 'Lake-zone specialist linking Mwanza, Kagera, Kigoma and Tabora.'
 where id = 'BUS007';

update buses set photo_path = 'juan-encalada-6mcVaoGNz1w-unsplash.jpg',
                 about = 'Southern highlands service with daily Iringa connections.'
 where id = 'BUS008';

update buses set photo_path = 'rafael-atantya-zK49QNwv8ow-unsplash.jpg',
                 about = 'Coastal express to Mtwara and Lindi.'
 where id = 'BUS009';

update buses set photo_path = 'xt7-core-U5jCcT1ZSHs-unsplash.jpg',
                 about = 'Adventure-class lake-zone connector.'
 where id = 'BUS010';
