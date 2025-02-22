import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, downloadContentFromMessage, fetchLatestBaileysVersion, isJidNewsletter, makeCacheableSignalKeyStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import fs from 'fs'
import path from 'path';
import P from 'pino'
import mysql from 'mysql'
import QRCode from 'qrcode'
import axios from 'axios'
import PDFDocument from 'pdfkit';
import blobStream from 'blob-stream';
import Table from 'pdfkit-table';

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const makeInMemoryStore = ({ logger }) => {
    const store = new Map();

    const filePath = path.resolve('./baileys_store_multi.json');

    const readFromFile = () => {
        try {
            const jsonStr = fs.readFileSync(filePath, 'utf-8');
            const json = JSON.parse(jsonStr);
            // Populate the store with data from JSON
            for (const key in json) {
                store.set(key, json[key]);
            }
        } catch (err) {
            logger.error('Error reading or parsing JSON file:', err);
        }
    };

    const writeToFile = () => {
        try {
            const jsonStr = JSON.stringify(Object.fromEntries(store), null, 2);
            fs.writeFileSync(filePath, jsonStr, 'utf-8');
        } catch (err) {
            logger.error('Error writing to JSON file:', err);
        }
    };

    return {
        readFromFile,
        writeToFile,
        bind: (ev) => {
            ev.on('creds.update', writeToFile);
        }
    };
};

const useStore = !process.argv.includes('--no-store')
const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

const msgRetryCounterCache = new NodeCache()
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile()
setInterval(() => {
    store?.writeToFile()
}, 10_000)

const userStates = new Map<string, any>();

let db;

const handleDisconnect = () => {
    db = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'jadwal'
    });

    db.connect((err) => {
        if (err) {
            console.error('Error connecting to MySQL:', err);
            setTimeout(handleDisconnect, 2000); // Coba koneksi ulang setelah 2 detik
        } else {
            console.log('Connected to MySQL Database.');
        }
    });

    db.on('error', (err) => {
        console.error('MySQL error:', err);
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            handleDisconnect(); // Hubungkan kembali jika koneksi terputus
        } else {
            throw err;
        }
    });
};

handleDisconnect();

const initializeUserState = (jid: string) => {
    if (!userStates.has(jid)) {
        console.log(`Initializing state for ${jid}`);
        userStates.set(jid, {
            awaitingClassSelection: true,
            awaitingJamSelection: false,
            awaitingAttendance: false,
            classOptions: [],
            jamOptions: [],
            students: [],
            currentIndex: 0,
            className: '',
            idjadwal: undefined,
            kode_guru: undefined
        });
    }
}

const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const toRad = (value) => value * Math.PI / 180;
    const R = 6371e3; // Radius bumi dalam meter
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Jarak dalam meter
}

const validateLocationWithNominatim = async (lat, lon) => {
    try {
        const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
            params: {
                lat: lat,
                lon: lon,
                format: 'json'
            }
        });
        const data = response.data;
        if (data && data.address) {
            return true; // Lokasi valid
        } else {
            return false; // Lokasi tidak valid
        }
    } catch (error) {
        console.error('Error fetching location data from Nominatim:', error);
        return false; // Terjadi kesalahan
    }
}

// Fungsi untuk mendapatkan pesan dari store
const getMessage = async (key: WAMessageKey): Promise<WAMessageContent | undefined> => {
    // Replace this with the correct implementation or remove if not needed
    return proto.Message.fromObject({})
}

const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage,
    })

    store?.bind(sock.ev)

    const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
        await sock.presenceSubscribe(jid)
        await delay(500)
        await sock.sendPresenceUpdate('composing', jid)
        await delay(2000)
        await sock.sendPresenceUpdate('paused', jid)
        await sock.sendMessage(jid, msg)
    }

    const sendMenu = async (jid: string) => {
        const menuMessage = {
            text: "📢 Sistem Informasi Guru.\n\n" +
                  "📚 *Menu Utama* 📚\n\n" +
                  "1️⃣ *#1. Jadwal Pelajaran*\n" +
                  "2️⃣ *#2. Absensi Kehadiran/Pulang*\n" +
                  "3️⃣ *#3. Absensi Siswa*\n" +
                  "4️⃣ *#4. Rekap Absensi*\n" +
                  "5️⃣ *#5. Absensi Kelas*\n\n" +  // Tambahkan menu #5
                  "Silahkan ketik angka dengan tanda pagar (#) yang sesuai:\n" +
                  "Contoh: *'#1' untuk Jadwal Pelajaran*"
        }
        await sendMessageWTyping(menuMessage, jid);
    }

    const handleMenuSelection = async (option: string, jid: string) => {
        switch (option) {
            case '#1':
                await displaySchedule(jid);
                break;
            case '#2':
                await promptForLocation(jid);
                break;
            case '#3':
                await promptForClassSelection(jid);
                break;
            case '#4':
                await promptForClassSelectionForSummary(jid);
                break;
            case '#5':
                await checkAllTeachersAttendance(jid);  // Handle menu #5
                break;
            default:
                await sendMessageWTyping({ text: 'Perintah tidak dikenal. Ketik #home untuk kembali ke menu utama.' }, jid);
                break;
        }
    }

    const promptForLocation = async (jid: string) => {
        // Periksa status absensi saat ini dan kirimkan pesan dengan detail absensi datang/pulang
        const phoneNumber = jid.split('@')[0];
        db.query('SELECT status FROM absensi WHERE nomor_hp = ? AND tanggal = CURDATE()', [phoneNumber], (err, results) => {
            if (err) {
                console.error('Database query error:', err);
                sendMessageWTyping({ text: 'Terjadi kesalahan saat memeriksa status absensi Anda.' }, jid);
                return;
            }

            let statusDatang = 'belum absen';
            let statusPulang = 'belum absen';

            results.forEach(result => {
                if (result.status === 'Absen Datang') {
                    statusDatang = 'sudah absen';
                } else if (result.status === 'Absen Pulang') {
                    statusPulang = 'sudah absen';
                }
            });

            let message = `Status absensi Anda untuk hari ini:\nDatang: ${statusDatang}\nPulang: ${statusPulang}`;

            if (statusDatang === 'sudah absen' && statusPulang === 'sudah absen') {
                message += `\n\nAbsensi datang dan pulang sudah dilakukan hari ini.`;
            } else if (statusDatang === 'belum absen') {
                message += `\n\nSilakan kirim lokasi Anda untuk absensi kedatangan.`;
                userStates.set(jid, { awaitingLocation: true, isPulang: false });
            } else if (statusPulang === 'belum absen') {
                message += `\n\nSilakan kirim lokasi Anda untuk absensi kepulangan.`;
                userStates.set(jid, { awaitingLocation: true, isPulang: true });
            }

            sendMessageWTyping({ text: message }, jid);
        });
    }

    const handleLocationMessage = async (jid: string, locationMessage) => {
        const userLat = locationMessage.degreesLatitude;
        const userLon = locationMessage.degreesLongitude;

        // Validasi lokasi menggunakan Nominatim
        const isValidLocation = await validateLocationWithNominatim(userLat, userLon);
        if (!isValidLocation) {
            await sendMessageWTyping({ text: 'Lokasi Anda tidak valid. Silakan coba lagi dari lokasi yang benar.' }, jid);
            return;
        }

        // Melanjutkan validasi jarak jika lokasi valid
        const expectedLat = -8.304053966712917; // Contoh latitude lokasi yang diharapkan
        const expectedLon = 114.13775847931268; // Contoh longitude lokasi yang diharapkan
        const radius = 100; // Radius dalam meter

        const distance = calculateDistance(expectedLat, expectedLon, userLat, userLon);

        if (distance <= radius) {
            // Ambil nama guru berdasarkan nomor_hp
            db.query('SELECT nama_guru FROM guru WHERE nomor_hp = ?', [jid.split('@')[0]], (err, results) => {
                if (err) {
                    console.error('Database query error:', err);
                    sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data guru.' }, jid);
                    return;
                }

                if (results.length === 0) {
                    sendMessageWTyping({ text: 'Guru dengan nomor HP tersebut tidak ditemukan.' }, jid);
                    return;
                }

                const namaGuru = results[0].nama_guru;

                // Periksa status absensi yang diharapkan
                const state = userStates.get(jid);
                const status = state.isPulang ? 'Absen Pulang' : 'Absen Datang';

                // Simpan data absensi ke database
                db.query('INSERT INTO absensi (nomor_hp, tanggal, waktu, status, lat, lon) VALUES (?, CURDATE(), CURTIME(), ?, ?, ?)',
                         [jid.split('@')[0], status, userLat, userLon], (err, result) => {
                    if (err) {
                        console.error('Database insert error:', err);
                        sendMessageWTyping({ text: 'Terjadi kesalahan saat menyimpan data absensi Anda.' }, jid);
                    } else {
                        const message = `Terima kasih, ${namaGuru}. Anda telah ${status.toLowerCase()}. Data absensi Anda telah disimpan.`;
                        sendMessageWTyping({ text: message }, jid);

                        // Hapus status pengguna setelah absensi berhasil
                        userStates.delete(jid);
                    }
                });
            });
        } else {
            await sendMessageWTyping({ text: 'Lokasi Anda tidak sesuai. Silakan coba lagi dari lokasi yang benar.' }, jid);
        }
    }

    const displaySchedule = async (jid: string) => {
        const phoneNumber = jid.split('@')[0];
        const today = new Date();
        const dayOfWeek = today.getDay();

        const dayMapping = {
            0: 'H',
            1: 'A',
            2: 'B',
            3: 'C',
            4: 'D',
            5: 'E',
            6: 'F'
        };

        const dayNames = {
            0: 'Minggu',
            1: 'Senin',
            2: 'Selasa',
            3: 'Rabu',
            4: 'Kamis',
            5: 'Jumat',
            6: 'Sabtu'
        };

        const currentDay = dayMapping[dayOfWeek];
        const currentDayName = dayNames[dayOfWeek];

        db.query('SELECT kode_jadwal FROM setting_jadwal LIMIT 1', (err, settingResults) => {
            if (err) {
                console.error('Database query error:', err);
                sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data pengaturan jadwal.' }, jid);
                return;
            }

            if (settingResults.length === 0) {
                sendMessageWTyping({ text: 'Pengaturan jadwal tidak ditemukan.' }, jid);
                return;
            }

            const kode_jadwal = settingResults[0].kode_jadwal;

            db.query('SELECT kode_guru FROM guru WHERE nomor_hp = ?', [phoneNumber], (err, results) => {
                if (err) {
                    console.error('Database query error:', err);
                    sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data guru.' }, jid);
                    return;
                }

                if (results.length === 0) {
                    sendMessageWTyping({ text: 'Guru dengan nomor HP tersebut tidak ditemukan.' }, jid);
                    return;
                }

                const kode_guru = results[0].kode_guru;

                db.query('SELECT * FROM jadwal WHERE kode_guru = ? AND hari = ? AND kode_jadwal = ? ORDER BY jam', [kode_guru, currentDay, kode_jadwal], (err, scheduleResults) => {
                    if (err) {
                        console.error('Database query error:', err);
                        sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil jadwal.' }, jid);
                        return;
                    }

                    if (scheduleResults.length === 0) {
                        sendMessageWTyping({ text: `Tidak ada jadwal yang ditemukan untuk hari ${currentDayName} dengan kode jadwal ${kode_jadwal}.` }, jid);
                        return;
                    }

                    let scheduleText = `Jadwal Anda hari ini (${currentDayName}) dengan kode jadwal ${kode_jadwal}:\n\n`;
                    const scheduleMap = new Map();

                    // Group schedule by mapel and kelas
                    scheduleResults.forEach(row => {
                        const key = `${row.kode_mapel}, ${row.kode_kelas}`;
                        if (!scheduleMap.has(key)) {
                            scheduleMap.set(key, []);
                        }
                        scheduleMap.get(key).push(row.jam);
                    });

                    // Format schedule text
                    let index = 1;
                    scheduleMap.forEach((jams, key) => {
                        jams.sort((a, b) => a - b);
                        const jamRange = `${jams[0]}-${jams[jams.length - 1]}`;
                        scheduleText += `${index}. Mapel: ${key} Jam(${jamRange})\n`;
                        index++;
                    });

                    sendMessageWTyping({ text: scheduleText }, jid);
                });
            });
        });
    }

    const generateScheduleText = (scheduleResults, currentDayName, kode_jadwal) => {
        let text = `Jadwal Anda hari ini (${currentDayName}) dengan kode jadwal ${kode_jadwal}:\n\n`;

        scheduleResults.forEach((row, index) => {
            text += `${index + 1}. Mapel: ${row.kode_mapel}, Kelas: ${row.kode_kelas}, Jam: ${row.jam}\n`;
        });

        return text;
    }

    const handleClassSelection = async (jid: string, classSelection: string) => {
        initializeUserState(jid);
        const state = userStates.get(jid);
        if (!state || !state.awaitingClassSelection) return;
        
        const classIndex = parseInt(classSelection) - 1;
        if (classIndex < 0 || classIndex >= state.classOptions.length) {
            await sendMessageWTyping({ text: 'Pilihan tidak valid. Silakan coba lagi.' }, jid);
            return;
        }
    
        const selectedClass = state.classOptions[classIndex];
        if (!selectedClass) {
            await sendMessageWTyping({ text: 'Kelas yang dipilih tidak ditemukan. Silakan coba lagi.' }, jid);
            return;
        }
    
        const phoneNumber = jid.split('@')[0];
        const today = new Date();
        const dayOfWeek = today.getDay();
    
        const dayNames = {
            0: 'Minggu',
            1: 'Senin',
            2: 'Selasa',
            3: 'Rabu',
            4: 'Kamis',
            5: 'Jumat',
            6: 'Sabtu'
        };
    
        const dayCodes = {
            'Minggu': 'H',
            'Senin': 'A',
            'Selasa': 'B',
            'Rabu': 'C',
            'Kamis': 'D',
            'Jumat': 'E',
            'Sabtu': 'F'
        };
    
        const currentDayName = dayNames[dayOfWeek];
        const currentDayCode = dayCodes[currentDayName];
    
        // Retrieve kode_guru based on phoneNumber
        db.query('SELECT kode_guru FROM guru WHERE nomor_hp = ?', [phoneNumber], async (err, guruResults) => {
            if (err) {
                console.error('Database query error:', err);
                await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data guru.' }, jid);
                return;
            }
    
            if (guruResults.length === 0) {
                await sendMessageWTyping({ text: 'Guru dengan nomor HP tersebut tidak ditemukan.' }, jid);
                return;
            }
    
            const kode_guru = guruResults[0].kode_guru;
            if (state) {
                state.kode_guru = kode_guru; // Save kode_guru in state
    
                db.query('SELECT kode_jadwal FROM setting_jadwal LIMIT 1', async (err, settingResults) => {
                    if (err) {
                        console.error('Database query error:', err);
                        await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data pengaturan jadwal.' }, jid);
                        return;
                    }
    
                    if (settingResults.length === 0) {
                        await sendMessageWTyping({ text: 'Pengaturan jadwal tidak ditemukan.' }, jid);
                        return;
                    }
    
                    const kode_jadwal = settingResults[0].kode_jadwal;
    
                    // Corrected query
                    db.query('SELECT DISTINCT jam, idjadwal, kode_mapel FROM jadwal WHERE kode_kelas = ? AND hari = ? AND kode_guru = ? AND kode_jadwal = ? ORDER BY jam', 
                        [selectedClass.kode_kelas, currentDayCode, kode_guru, kode_jadwal], async (err, results) => {
                        if (err) {
                            console.error('Database query error:', err);
                            await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data jam.' }, jid);
                            return;
                        }
    
                        if (results.length === 0) {
                            await sendMessageWTyping({ text: `Tidak ada jadwal yang ditemukan untuk kelas ${selectedClass.kode_kelas} dengan kode guru Anda ${kode_guru} pada hari ${currentDayCode} ${currentDayName} dan kode_jadwal ${kode_jadwal}.` }, jid);
                            return;
                        }
    
                        // Set jamOptions and idJadwalOptions in state
                        if (state) {
                            state.jamOptions = results.map(row => row.jam);
                            state.idJadwalOptions = results.map(row => row.idjadwal);
                            state.kode_mapel = results[0].kode_mapel; // Save kode_mapel in state
                            state.awaitingClassSelection = false;
                            state.awaitingAttendance = true;
                            state.currentIndex = 0;
                            state.className = selectedClass.kode_kelas;
    
                            // Fetch students for the selected class and set in state
                            state.students = await fetchStudentsForClass(selectedClass.kode_kelas);
    
                            // Urutkan siswa berdasarkan abjad
                            state.students.sort((a, b) => a.nama_siswa.localeCompare(b.nama_siswa));
    
                            // Display all students with default 'h' status and save to database
                            const attendanceRecords = state.students.flatMap((student) =>
                                state.idJadwalOptions.map((idjadwal, index) => ({
                                    nisn: student.nisn,
                                    kelas: state.className,
                                    tanggal: new Date().toISOString().split('T')[0],
                                    idjadwal: idjadwal,
                                    jam: state.jamOptions[index], // Ensure jam is correctly set
                                    status: 'h', // Default status is 'h' for hadir
                                    kode_guru: state.kode_guru
                                }))
                            );
    
                            console.log('Attendance Records:', attendanceRecords);
    
                            // Save attendance records to database
                            const query = 'INSERT INTO absensi_siswa (nisn, kelas, tanggal, idjadwal, jam, status, kode_guru) VALUES ?';
                            const values = attendanceRecords.map(record => [
                                record.nisn, record.kelas, record.tanggal, record.idjadwal, record.jam, record.status, record.kode_guru
                            ]);
    
                            db.query(query, [values], (err, result) => {
                                if (err) {
                                    console.error('Database insert error:', err);
                                    sendMessageWTyping({ text: 'Terjadi kesalahan saat menyimpan data absensi.' }, jid);
                                } else {
                                    sendMessageWTyping({ text: `Absensi kelas ${state.className} telah disimpan. Semua siswa diabsen dengan status hadir (h).` }, jid);
                                    promptForNonAttendingStudents(jid, state.students);
                                }
                            });
                        }
                    });
                });
            }
        });
    }
    
    const fetchStudentsForClass = async (className: string) => {
        // Replace with actual database query to fetch students
        return new Promise<any[]>((resolve, reject) => {
            db.query('SELECT nisn, nama_siswa FROM siswa WHERE kelas = ? ORDER BY nama_siswa ASC', [className], (err, results) => {
                if (err) {
                    console.error('Database query error:', err);
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });
    }
    
    const promptForNonAttendingStudents = async (jid: string, students: any[]) => {
        let message = 'Silakan kirim nomor urut siswa yang tidak hadir dengan format: nomor urut#status sesuai jam.\nContoh: 1#sss (a:alpha, s:sakit, i:izin, t:terlambat)\n\nDaftar siswa:\n';
    
        students.forEach((student, index) => {
            message += `${index + 1}. ${student.nama_siswa}\n`;
        });
    
        await sendMessageWTyping({ text: message }, jid);
    }
    
    const handleNonAttendanceSubmission = async (jid: string, submissions: string) => {
        const state = userStates.get(jid);
        if (!state || !state.awaitingAttendance) return;
    
        // Cek jika perintah adalah #back atau #home
        if (submissions === '#back') {
            await promptForClassSelection(jid);
            return;
        } else if (submissions === '#home') {
            await sendMenu(jid);
            return;
        }
    
        // Pisahkan input berdasarkan baris baru
        const entries = submissions.split('\n');
    
        const updatePromises = entries.map(async (entry) => {
            const [indexStr, status] = entry.split('#');
            const studentIndex = parseInt(indexStr) - 1;
    
            if (studentIndex < 0 || studentIndex >= state.students.length) {
                await sendMessageWTyping({ text: `Nomor urut siswa ${indexStr} tidak valid. Silakan coba lagi.` }, jid);
                return;
            }
    
            const student = state.students[studentIndex];
    
            if (status.length !== state.jamOptions.length) {
                await sendMessageWTyping({ text: `Jumlah status untuk siswa ${student.nama_siswa} tidak sesuai dengan jumlah jam pelajaran (${state.jamOptions.length}). Silakan coba lagi.` }, jid);
                return;
            }
    
            // Update attendance record in database for each idjadwal
            const attendanceUpdates = status.split('').map((statusChar, index) => ({
                nisn: student.nisn,
                idjadwal: state.idJadwalOptions[index],
                jam: state.jamOptions[index], // Ensure jam is correctly set
                status: statusChar
            }));
    
            await Promise.all(attendanceUpdates.map(async (update) => {
                const query = 'UPDATE absensi_siswa SET status = ? WHERE nisn = ? AND idjadwal = ? AND tanggal = CURDATE()';
                return new Promise<void>((resolve, reject) => {
                    db.query(query, [update.status, update.nisn, update.idjadwal], (err, result) => {
                        if (err) {
                            console.error('Database update error:', err);
                            sendMessageWTyping({ text: `Terjadi kesalahan saat memperbarui data absensi untuk siswa ${student.nama_siswa}.` }, jid);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            }));
    
            await sendMessageWTyping({ text: `Status absensi untuk ${student.nama_siswa} telah diperbarui.` }, jid);
        });
    
        await Promise.all(updatePromises);
    
        await sendMessageWTyping({ text: 'Semua status absensi yang dimasukkan telah diperbarui. Ketik #back atau #home untuk kembali. Atau anda bisa melanjutkan absensi kembali' }, jid);
    
        // Tetap pada status awaitingAttendance untuk absensi siswa selanjutnya
        state.awaitingAttendance = true;
    
        // Prompt untuk siswa berikutnya atau kirim pesan selesai jika semua siswa telah diabsen
        if (state.currentIndex < state.students.length - 1) {
            state.currentIndex++;
            // Tidak menampilkan pesan untuk siswa berikutnya
        } else {
            await sendMessageWTyping({ text: 'Semua siswa telah diabsen. Terima kasih.' }, jid);
            userStates.set(jid, { awaitingClassSelection: false, awaitingAttendance: false, awaitingMenuSelection: true });
        }
    }
    
    const handleJamSelection = async (jid: string, jamSelection: string) => {
        initializeUserState(jid);
        const state = userStates.get(jid);
        if (!state || !state.awaitingJamSelection) return;
    
        // Parse the jam selection input
        const jamRange = jamSelection.split('-').map(num => parseInt(num.trim()));
        let jamOptions: string[] = []; // Explicitly define the type as an array of strings
    
        // Ensure the input is valid
        if (jamRange.length === 2 && !isNaN(jamRange[0]) && !isNaN(jamRange[1]) && jamRange[0] <= jamRange[1]) {
            for (let i = jamRange[0]; i <= jamRange[1]; i++) {
                jamOptions.push(`Jam ke-${i}`);
            }
        } else {
            await sendMessageWTyping({ text: 'Pilihan jam tidak valid. Silakan coba lagi.' }, jid);
            return;
        }
    
        // Set jamOptions in state
        if (state) {
            state.jamOptions = jamOptions;
            state.awaitingJamSelection = false;
            state.awaitingAttendance = true;
            state.currentIndex = 0;
    
            // Fetch students for the selected class and set in state
            state.students = await fetchStudentsForClass(state.className);
    
            // Continue to prompt for student attendance
            await promptForStudentAttendance(jid);
        }
    }    
     
    const promptForStudentAttendance = async (jid: string) => {
        const state = userStates.get(jid);
        if (!state || !state.awaitingAttendance || !state.students || state.currentIndex >= state.students.length) return;
    
        const student = state.students[state.currentIndex];
        const jamOptions = state.jamOptions;
    
        await sendMessageWTyping({
            text: `Kelas: ${state.className}\nNama: ${student.nama_siswa}\n\nJika siswa hadir di semua jam, cukup ketik 'h'.\nJika ada perbedaan status, gunakan format 'h,i,s,a' untuk Jam (${jamOptions[0]}-${jamOptions[jamOptions.length - 1]}).\n\nAnda juga bisa mengetik '#back' untuk kembali ke menu pemilihan kelas atau '#home' untuk kembali ke menu utama kapan saja.`
        }, jid);
    }  
    
    type AttendanceSummary = {
        name: string;
        jam: string;
    };
    
    const generateAttendanceSummary = (students: any[], jamOptions: number[]): { summary: { hadir: AttendanceSummary[], absen: AttendanceSummary[], sakit: AttendanceSummary[], izin: AttendanceSummary[] }, statusCount: { hadir: number, absen: number, sakit: number, izin: number } } => {
        const summary = {
            hadir: [] as AttendanceSummary[],
            absen: [] as AttendanceSummary[],
            sakit: [] as AttendanceSummary[],
            izin: [] as AttendanceSummary[]
        };
    
        const statusCount = {
            hadir: 0,
            absen: 0,
            sakit: 0,
            izin: 0
        };
    
        students.forEach(student => {
            let isAbsent = false, isSick = false, isPermission = false;
            student.statuses.forEach((statusObj: any, index: number) => {
                const jam = jamOptions[index];
                if (jam === undefined) {
                    console.error(`Jam tidak ditemukan untuk index ${index} dan student ${student.nama_siswa}`);
                    return;
                }
                const { status } = statusObj; // pastikan kita mengakses properti status dengan benar
                switch (status) {
                    case 'h':
                        summary.hadir.push({ name: student.nama_siswa, jam: jam.toString() });
                        console.log(`Hadir: ${student.nama_siswa}, Jam: ${jam}`);
                        break;
                    case 'a':
                        summary.absen.push({ name: student.nama_siswa, jam: jam.toString() });
                        isAbsent = true;
                        console.log(`Absen: ${student.nama_siswa}, Jam: ${jam}`);
                        break;
                    case 's':
                        summary.sakit.push({ name: student.nama_siswa, jam: jam.toString() });
                        isSick = true;
                        console.log(`Sakit: ${student.nama_siswa}, Jam: ${jam}`);
                        break;
                    case 'i':
                        summary.izin.push({ name: student.nama_siswa, jam: jam.toString() });
                        isPermission = true;
                        console.log(`Izin: ${student.nama_siswa}, Jam: ${jam}`);
                        break;
                    default:
                        console.log(`Status tidak dikenal: ${student.nama_siswa}, Jam: ${jam}, Status: ${status}`);
                }
            });
            if (!isAbsent && !isSick && !isPermission) {
                statusCount.hadir++;
            }
        });
    
        statusCount.absen = summary.absen.length;
        statusCount.sakit = summary.sakit.length;
        statusCount.izin = summary.izin.length;
    
        console.log('Summary:', summary);
        console.log('Status Count:', statusCount);
    
        return { summary, statusCount };
    };
    
    const displayAttendanceSummary = async (jid: string, className: string, mapel: string, summary: any, totalHadir: number, totalSiswa: number, jamOptions: number[], kode_guru: string, kode_mapel: string) => {
        const currentDate = new Date();
        const formattedDate = `${currentDate.getDate().toString().padStart(2, '0')}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-${currentDate.getFullYear()}`; // Format tanggal DD-MM-YYYY
    
        let message = `Rekap Absensi Kelas ${className} Mapel: ${mapel} Guru: ${kode_guru}\nTanggal: ${formattedDate}\n\n`;
    
        const generateCountMapWithDetails = (summaryArray: any[]) => {
            const countMap: { [name: string]: { count: number, jams: number[] } } = {};
            summaryArray.forEach(item => {
                if (countMap[item.name]) {
                    countMap[item.name].count++;
                    countMap[item.name].jams.push(parseInt(item.jam));
                } else {
                    countMap[item.name] = { count: 1, jams: [parseInt(item.jam)] };
                }
            });
            return countMap;
        };
    
        const appendSummaryWithDetails = (title: string, countMap: { [name: string]: { count: number, jams: number[] } }) => {
            message += `${title}\n`;
            if (Object.keys(countMap).length > 0) {
                Object.keys(countMap).forEach((name, index) => {
                    const jamRanges = getJamRanges(countMap[name].jams);
                    const jamDetails = jamRanges.map(range => range.join('-')).join(', ');
                    message += `${index + 1}. ${name} = ${countMap[name].count} jp (jam ke:${jamDetails})\n`;
                });
            } else {
                message += '-\n';
            }
            message += '\n';
        };
    
        const getJamRanges = (jams: number[]) => {
            jams.sort((a, b) => a - b);
            const ranges: number[][] = [];
            let rangeStart = jams[0];
            let rangeEnd = jams[0];
    
            for (let i = 1; i < jams.length; i++) {
                if (jams[i] === rangeEnd + 1) {
                    rangeEnd = jams[i];
                } else {
                    ranges.push([rangeStart, rangeEnd]);
                    rangeStart = jams[i];
                    rangeEnd = jams[i];
                }
            }
            ranges.push([rangeStart, rangeEnd]);
            return ranges;
        };
    
        // Generate count maps with details for each status
        const absenCountMap = generateCountMapWithDetails(summary.absen);
        const sakitCountMap = generateCountMapWithDetails(summary.sakit);
        const izinCountMap = generateCountMapWithDetails(summary.izin);
    
        // Append summaries with details to the message
        appendSummaryWithDetails('Absen/Bolos', absenCountMap);
        appendSummaryWithDetails('Sakit', sakitCountMap);
        appendSummaryWithDetails('Izin', izinCountMap);
    
        // Calculate the number of students who are present
        const totalAbsent = Object.keys(absenCountMap).length;
        const totalSick = Object.keys(sakitCountMap).length;
        const totalPermission = Object.keys(izinCountMap).length;
        const totalPresent = totalSiswa - totalAbsent - totalSick - totalPermission;
    
        // Append total kehadiran
        message += `Total kehadiran (Jam ke ${jamOptions[0]}-${jamOptions[jamOptions.length - 1]}) = ${totalPresent} Siswa\n`;
    
        console.log('Rekap Absensi:', message);
        console.log('Summary:', summary);
    
        await sendMessageWTyping({ text: message }, jid);
    };
    
    const promptForClassSelection = async (jid: string) => {
        const phoneNumber = jid.split('@')[0];
        const today = new Date();
        const dayOfWeek = today.getDay();
    
        // Mapping hari ke kode yang digunakan di database
        const dayCodes = {
            0: 'H',
            1: 'A',
            2: 'B',
            3: 'C',
            4: 'D',
            5: 'E',
            6: 'F'
        };
    
        const dayNames = {
            0: 'Minggu',
            1: 'Senin',
            2: 'Selasa',
            3: 'Rabu',
            4: 'Kamis',
            5: 'Jumat',
            6: 'Sabtu'
        };
    
        const currentDayName = dayNames[dayOfWeek];
        const currentDayCode = dayCodes[dayOfWeek];
        console.log(`Processing for day: ${currentDayName} (${currentDayCode})`);
    
        db.query('SELECT kode_guru FROM guru WHERE nomor_hp = ?', [phoneNumber], (err, results) => {
            if (err) {
                console.error('Database query error (guru):', err);
                sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data guru.' }, jid);
                return;
            }
    
            if (results.length === 0) {
                sendMessageWTyping({ text: 'Guru dengan nomor HP tersebut tidak ditemukan.' }, jid);
                return;
            }
    
            const kode_guru = results[0].kode_guru;
            console.log(`Found kode_guru: ${kode_guru}`);
    
            db.query('SELECT kode_jadwal FROM setting_jadwal LIMIT 1', (err, settingResults) => {
                if (err) {
                    console.error('Database query error (setting_jadwal):', err);
                    sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data pengaturan jadwal.' }, jid);
                    return;
                }
    
                if (settingResults.length === 0) {
                    sendMessageWTyping({ text: 'Pengaturan jadwal tidak ditemukan.' }, jid);
                    return;
                }
    
                const kode_jadwal = settingResults[0].kode_jadwal;
                console.log(`Found kode_jadwal: ${kode_jadwal}`);
    
                db.query('SELECT kode_kelas, kode_mapel, GROUP_CONCAT(jam ORDER BY jam) AS jam FROM jadwal WHERE kode_guru = ? AND hari = ? AND kode_jadwal = ? GROUP BY kode_kelas, kode_mapel ORDER BY FIELD(kode_mapel, "BJawa", "Mtk"), jam', [kode_guru, currentDayCode, kode_jadwal], (err, classResults) => {
                    if (err) {
                        console.error('Database query error (jadwal):', err);
                        sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data kelas.' }, jid);
                        return;
                    }
    
                    if (classResults.length === 0) {
                        sendMessageWTyping({ text: `Tidak ada kelas yang diampu pada hari ${currentDayName}.` }, jid);
                        return;
                    }
    
                    console.log(`Found ${classResults.length} classes`);
                    let message = `Jadwal Anda hari ini (${currentDayName}) dengan kode jadwal ${kode_jadwal}:\n\n`;
                    const classOptions = classResults.map(row => ({ kode_kelas: row.kode_kelas, kode_mapel: row.kode_mapel, jam: row.jam }));
    
                    classOptions.forEach((option, index) => {
                        message += `${index + 1}. Mapel: ${option.kode_mapel}, Kelas: ${option.kode_kelas}, Jam: ${option.jam}\n`;
                    });
    
                    message += '\nSilakan kirim nomor kelas yang akan diabsen:';
                    sendMessageWTyping({ text: message }, jid);
                    userStates.set(jid, { awaitingClassSelection: true, classOptions });
                });
            });
        });
    }
    
    const promptForClassSelectionForSummary = async (jid: string) => {
        const phoneNumber = jid.split('@')[0];
        const today = new Date();
        const dayOfWeek = today.getDay();
    
        const dayCodes = {
            0: 'H',
            1: 'A',
            2: 'B',
            3: 'C',
            4: 'D',
            5: 'E',
            6: 'F'
        };
    
        const dayNames = {
            0: 'Minggu',
            1: 'Senin',
            2: 'Selasa',
            3: 'Rabu',
            4: 'Kamis',
            5: 'Jumat',
            6: 'Sabtu'
        };
    
        const currentDayName = dayNames[dayOfWeek];
        const currentDayCode = dayCodes[dayOfWeek];
    
        db.query('SELECT kode_guru FROM guru WHERE nomor_hp = ?', [phoneNumber], (err, results) => {
            if (err) {
                console.error('Database query error (guru):', err);
                sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data guru.' }, jid);
                return;
            }
    
            if (results.length === 0) {
                sendMessageWTyping({ text: 'Guru dengan nomor HP tersebut tidak ditemukan.' }, jid);
                return;
            }
    
            const kode_guru = results[0].kode_guru;
    
            db.query('SELECT kode_jadwal FROM setting_jadwal LIMIT 1', (err, settingResults) => {
                if (err) {
                    console.error('Database query error (setting_jadwal):', err);
                    sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data pengaturan jadwal.' }, jid);
                    return;
                }
    
                if (settingResults.length === 0) {
                    sendMessageWTyping({ text: 'Pengaturan jadwal tidak ditemukan.' }, jid);
                    return;
                }
    
                const kode_jadwal = settingResults[0].kode_jadwal;
    
                console.log(`Found kode_jadwal: ${kode_jadwal}`);
    
                db.query('SELECT kode_kelas, kode_mapel, GROUP_CONCAT(jam ORDER BY jam) AS jam FROM jadwal WHERE kode_guru = ? AND kode_jadwal = ? AND hari = ? GROUP BY kode_kelas, kode_mapel ORDER BY MIN(jam)', [kode_guru, kode_jadwal, currentDayCode], (err, classResults) => {
                    if (err) {
                        console.error('Database query error (jadwal):', err);
                        sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data kelas.' }, jid);
                        return;
                    }
    
                    if (classResults.length === 0) {
                        sendMessageWTyping({ text: `Tidak ada kelas yang diampu pada hari ${currentDayName}.` }, jid);
                        return;
                    }
    
                    console.log(`Found ${classResults.length} classes`);
                    let message = `Pilih kelas dan mata pelajaran untuk rekap absensi:\n\n`;
                    const classOptions = classResults.map(row => `${row.kode_kelas} - ${row.kode_mapel} (Jam: ${row.jam})`);
    
                    classOptions.forEach((option, index) => {
                        message += `${index + 1}. ${option}\n`;
                    });
    
                    message += '\nSilakan kirim nomor pilihan Anda:';
                    sendMessageWTyping({ text: message }, jid);
                    userStates.set(jid, { awaitingClassAndMapelSelection: true, classOptions, kode_guru });
                });
            });
        });
    }
    
    const handleClassAndMapelSelection = async (jid: string, selection: string) => {
        const state = userStates.get(jid);
        if (!state || !state.awaitingClassAndMapelSelection) return;
    
        const selectedOptionIndex = parseInt(selection) - 1;
        if (selectedOptionIndex < 0 || !state.classOptions[selectedOptionIndex]) {
            await sendMessageWTyping({ text: 'Pilihan tidak valid. Silakan coba lagi.' }, jid);
            return;
        }
    
        const [selectedClassMapel, jam] = state.classOptions[selectedOptionIndex].split(' (Jam: ');
        const [selectedClass, selectedMapel] = selectedClassMapel.split(' - ');
        const jamRange = jam.replace(')', '').split(',').map(Number); // Pastikan tipe data adalah number
    
        const kode_guru = state.kode_guru;
    
        // Mengambil kode_jadwal dari tabel setting_jadwal
        db.query('SELECT kode_jadwal FROM setting_jadwal LIMIT 1', (err, settingResults) => {
            if (err) {
                console.error('Database query error (setting_jadwal):', err);
                sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data pengaturan jadwal.' }, jid);
                return;
            }
    
            if (settingResults.length === 0) {
                sendMessageWTyping({ text: 'Pengaturan jadwal tidak ditemukan.' }, jid);
                return;
            }
    
            const kode_jadwal = settingResults[0].kode_jadwal;
    
            const today = new Date();
            const dayOfWeek = today.getDay();
    
            const dayCodes = {
                0: 'H',
                1: 'A',
                2: 'B',
                3: 'C',
                4: 'D',
                5: 'E',
                6: 'F'
            };
    
            const currentDayCode = dayCodes[dayOfWeek];
    
            // Mengambil idjadwal dari tabel jadwal
            db.query('SELECT idjadwal FROM jadwal WHERE kode_guru = ? AND kode_kelas = ? AND kode_mapel = ? AND kode_jadwal = ? AND hari = ? AND jam IN (?)', 
                     [kode_guru, selectedClass, selectedMapel, kode_jadwal, currentDayCode, jamRange], (err, jadwalResults) => {
                if (err) {
                    console.error('Database query error:', err);
                    sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data jadwal.' }, jid);
                    return;
                }
    
                if (jadwalResults.length === 0) {
                    sendMessageWTyping({ text: `Tidak ada jadwal yang ditemukan untuk kelas ${selectedClass} dan mapel ${selectedMapel} pada hari ini.` }, jid);
                    return;
                }
    
                // Menyimpan idjadwal dalam idjadwalList
                const idjadwalList = jadwalResults.map(row => row.idjadwal);
                console.log('idjadwalList:', idjadwalList);
    
                // Mengambil data absensi siswa berdasarkan idjadwal
                db.query('SELECT nisn, jam, status FROM absensi_siswa WHERE kode_guru = ? AND idjadwal IN (?) AND tanggal = CURDATE()', 
                         [kode_guru, idjadwalList], async (err, absensiResults) => {
                    if (err) {
                        console.error('Database query error:', err);
                        sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data absensi.' }, jid);
                        return;
                    }
    
                    if (absensiResults.length === 0) {
                        sendMessageWTyping({ text: `Tidak ada data absensi untuk kelas ${selectedClass} dan mapel ${selectedMapel} hari ini.` }, jid);
                        return;
                    }
    
                    console.log('Absensi Results:', absensiResults);
    
                    const nisnList = absensiResults.map(row => row.nisn);
                    const studentNames = await fetchStudentNames(nisnList); // Ambil nama siswa berdasarkan NISN
    
                    const studentsMap = new Map();
                    absensiResults.forEach(row => {
                        if (!studentsMap.has(row.nisn)) {
                            studentsMap.set(row.nisn, { nama_siswa: studentNames[row.nisn] || row.nisn, statuses: [] });
                        }
                        studentsMap.get(row.nisn).statuses.push({ jam: row.jam, status: row.status });
                    });
    
                    const students = Array.from(studentsMap.values());
                    const jamOptions = Array.from(new Set(absensiResults.map(row => row.jam))).map(jam => Number(jam)).sort((a, b) => a - b); // Pastikan tipe data adalah number[]
    
                    console.log('Students:', students);
                    console.log('Jam Options:', jamOptions);
    
                    const { summary, statusCount } = generateAttendanceSummary(students, jamOptions);
                    displayAttendanceSummary(jid, selectedClass, selectedMapel, summary, statusCount.hadir, students.length, jamOptions, kode_guru, selectedMapel);
            });
        });
      });
    };
    
const fetchStudentsByNisn = async (nisn) => {
    return new Promise((resolve, reject) => {
        db.query('SELECT nisn, nama_siswa FROM siswa WHERE nisn = ?', [nisn], (err, results) => {
            if (err) {
                console.error('Database query error:', err);
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
};

const fetchStudentNames = async (nisnList: string[]): Promise<{ [key: string]: string }> => {
    return new Promise((resolve, reject) => {
        const query = 'SELECT nisn, nama_siswa FROM siswa WHERE nisn IN (?)';
        db.query(query, [nisnList], (err, results) => {
            if (err) {
                console.error('Database query error:', err);
                reject(err);
            } else {
                const nameMap = results.reduce((map, student) => {
                    map[student.nisn] = student.nama_siswa;
                    return map;
                }, {});
                resolve(nameMap);
            }
        });
    });
};

interface Student {
    name: string;
    hours: string[];
}
// Pastikan tipe Detail diperbarui untuk menyertakan idjadwal
type Detail = {
    mapel: string;
    jams: number[];
    idjadwal: any; // Tambahkan properti idjadwal
};

const generateAndSendAttendancePDF = (filePath: string, className: string, date: string, attendanceData: any[], callback: () => void) => {
    const doc = new PDFDocument({ margin: 30 });

    // Save the PDF to a file
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Add the title
    doc.fontSize(20).text(`Absensi Kelas ${className}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(16).text(`Tanggal: ${date}`, { align: 'center' });
    doc.moveDown();

    // Define the number of hours
    const totalHours = 9;

    // Create table headers
    const headers = ['No.', 'Nama Siswa'];
    for (let i = 1; i <= totalHours; i++) {
        headers.push(i.toString());
    }

    // Draw table headers
    const headerX = 50;
    let rowY = doc.y;
    headers.forEach((header, index) => {
        doc.fontSize(12).text(header, headerX + index * 50, rowY, { width: 50, align: 'center' });
    });
    doc.moveDown();

    // Draw table rows
    attendanceData.forEach((student, rowIndex) => {
        rowY = doc.y;
        const row = [(rowIndex + 1).toString(), student.name, ...student.hours];
        row.forEach((cell, cellIndex) => {
            doc.fontSize(12).text(cell, headerX + cellIndex * 50, rowY, { width: 50, align: 'center' });
        });
        doc.moveDown();
    });

    doc.end();

    stream.on('finish', callback);
};
const generateAndSendAttendanceReport = async (jid: string, kelas: string, date: string) => {
    // Ensure the directory exists
    const dirPath = path.resolve('./attendance_reports');
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    db.query('SELECT s.nama_siswa, a.jam, a.status FROM absensi_siswa a JOIN siswa s ON a.nisn = s.nisn WHERE a.kelas = ? AND a.tanggal = ?', [kelas, date], async (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data absensi siswa.' }, jid);
            return;
        }

        if (results.length === 0) {
            await sendMessageWTyping({ text: 'Tidak ada data absensi siswa untuk kelas ini.' }, jid);
            return;
        }

        // Mengelompokkan data absensi siswa berdasarkan nama
        const attendanceData = results.reduce((acc: any, row: any) => {
            if (!acc[row.nama_siswa]) {
                acc[row.nama_siswa] = [];
            }
            acc[row.nama_siswa][row.jam - 1] = row.status; // Pastikan index jam dimulai dari 0
            return acc;
        }, {});

        const attendanceArray = Object.keys(attendanceData).map(name => ({
            name,
            hours: attendanceData[name]
        }));

        // Generate PDF
        const filePath = path.resolve(`./attendance_reports/Attendance_${kelas}_${date}.pdf`);
        generateAndSendAttendancePDF(filePath, kelas, date, attendanceArray, async () => {
            // Send PDF file
            const fileContent = fs.readFileSync(filePath);
            const pdfMessage = {
                document: fileContent,
                mimetype: 'application/pdf',
                fileName: `Attendance_${kelas}_${date}.pdf`
            };
            await sendMessageWTyping(pdfMessage, jid);
        });
    });
};
const checkAllTeachersAttendance = async (jid: string) => {
    console.log(`Received text message: #5 from ${jid}`);
    const phoneNumber = jid.split('@')[0];
    console.log(`Checking attendance for phone number: ${phoneNumber}`);

    db.query('SELECT kode_guru FROM guru WHERE nomor_hp = ?', [phoneNumber], async (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data guru.' }, jid);
            return;
        }

        if (results.length === 0) {
            console.log('No teacher found with the provided phone number.');
            await sendMessageWTyping({ text: 'Guru dengan nomor HP tersebut tidak ditemukan.' }, jid);
            return;
        }

        const { kode_guru } = results[0];
        console.log(`Found teacher with kode_guru: ${kode_guru}`);

        // Check if the teacher is wali kelas
        db.query('SELECT kelas FROM guru WHERE kode_guru = ? AND jabatan = "walikelas"', [kode_guru], async (err, results) => {
            if (err) {
                console.error('Database query error:', err);
                await sendMessageWTyping({ text: 'Terjadi kesalahan saat memeriksa jabatan guru.' }, jid);
                return;
            }

            if (results.length === 0) {
                console.log(`Teacher with kode_guru ${kode_guru} is not a wali kelas.`);
                await sendMessageWTyping({ text: 'Menu ini hanya tersedia untuk wali kelas.' }, jid);
                return;
            }

            const { kelas } = results[0];
            console.log(`Teacher is wali kelas for class: ${kelas}`);

            // Get kode_jadwal from setting_jadwal
            db.query('SELECT kode_jadwal FROM setting_jadwal LIMIT 1', (err, settingResults) => {
                if (err) {
                    console.error('Database query error:', err);
                    sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data pengaturan jadwal.' }, jid);
                    return;
                }

                if (settingResults.length === 0) {
                    console.log('No jadwal settings found.');
                    sendMessageWTyping({ text: 'Pengaturan jadwal tidak ditemukan.' }, jid);
                    return;
                }

                const kode_jadwal = settingResults[0].kode_jadwal;
                console.log(`Using kode_jadwal: ${kode_jadwal}`);

                // Get idjadwal for the class and specific day
                const today = new Date();
                const dayOfWeek = today.getDay();
                const dayMap = ['H', 'A', 'B', 'C', 'D', 'E', 'F'];
                const dayLetter = dayMap[dayOfWeek];
                console.log(`Today is day of the week: ${dayOfWeek} (letter: ${dayLetter})`);

                db.query('SELECT idjadwal, jam, kode_mapel FROM jadwal WHERE kode_kelas = ? AND kode_jadwal = ? AND hari = ? ORDER BY jam', [kelas, kode_jadwal, dayLetter], async (err, idjadwalResults) => {
                    if (err) {
                        console.error('Database query error:', err);
                        await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil data jadwal.' }, jid);
                        return;
                    }

                    if (idjadwalResults.length === 0) {
                        console.log('No jadwal found for the current day.');
                        await sendMessageWTyping({ text: 'Tidak ada jadwal yang ditemukan untuk hari ini.' }, jid);
                        return;
                    }

                    const idjadwalList = idjadwalResults.map((row: any) => row.idjadwal);
                    const jamMap: { [key: number]: number[] } = {};
                    const mapelMap: { [key: number]: string } = {};
                    idjadwalResults.forEach((row: any) => {
                        if (!jamMap[row.idjadwal]) {
                            jamMap[row.idjadwal] = [];
                        }
                        jamMap[row.idjadwal].push(row.jam);
                        mapelMap[row.idjadwal] = row.kode_mapel;
                    });
                    console.log(`Found idjadwal(s): ${idjadwalList.join(', ')}`);

                    // Check which teachers have not marked attendance for the class
                    const formattedDate = today.toISOString().split('T')[0];
                    console.log(`Checking attendance for date: ${formattedDate}`);

                    db.query('SELECT g.nama_guru, j.idjadwal, j.jam, j.kode_mapel FROM jadwal j LEFT JOIN absensi_siswa a ON j.idjadwal = a.idjadwal AND a.tanggal = ? LEFT JOIN guru g ON j.kode_guru = g.kode_guru WHERE j.idjadwal IN (?) AND a.idjadwal IS NULL ORDER BY j.jam', [formattedDate, idjadwalList], async (err, results) => {
                        if (err) {
                            console.error('Database query error:', err);
                            await sendMessageWTyping({ text: 'Terjadi kesalahan saat memeriksa absensi guru.' }, jid);
                            return;
                        }

                        if (results.length > 0) {
                            const unmarkedTeachersMap: { [key: string]: any[] } = {};
                            results.forEach((row: any) => {
                                if (!unmarkedTeachersMap[row.nama_guru]) {
                                    unmarkedTeachersMap[row.nama_guru] = [];
                                }
                                unmarkedTeachersMap[row.nama_guru].push({
                                    mapel: mapelMap[row.idjadwal],
                                    jams: jamMap[row.idjadwal],
                                    idjadwal: row.idjadwal
                                });
                            });

                            let unmarkedTeachersList = '';
                            let i = 1;
                            for (const [teacher, details] of Object.entries(unmarkedTeachersMap)) {
                                const mapelJam = (details as any[]).reduce((acc, detail) => {
                                    if (!acc[detail.mapel]) {
                                        acc[detail.mapel] = [];
                                    }
                                    acc[detail.mapel] = acc[detail.mapel].concat(detail.jams);
                                    return acc;
                                }, {} as { [mapel: string]: number[] });

                                const mapelJamDetails = Object.entries(mapelJam).map(([mapel, jams]) => {
                                    return `Mapel: ${mapel}, Jam: (${(jams as number[]).join(',')})`;
                                }).join(' - ');

                                unmarkedTeachersList += `${i}. ${teacher} - ${mapelJamDetails}\n`;
                                i++;
                            }

                            console.log(`Unmarked teachers: ${unmarkedTeachersList}`);
                            await sendMessageWTyping({ text: `Guru yang belum absen di kelas ${kelas} pada tanggal ${formattedDate}:\n${unmarkedTeachersList}\n\nSilakan pilih nomor guru untuk melihat detail absensi siswa.` }, jid);
                            userStates.set(jid, { awaitingTeacherSelection: true, unmarkedTeachersMap, kode_guru, kelas });
                        } else {
                            console.log('All teachers have marked their attendance.');
                            await sendMessageWTyping({ text: `Semua guru telah mengisi absensi di kelas ${kelas} pada tanggal ${formattedDate}.` }, jid);
                            // Generate and send attendance report PDF
                            await generateAndSendAttendanceReport(jid, kelas, formattedDate);
                        }
                    });
                });
            });
        });
    });
};
const handleTeacherSelection = async (jid: string, input: string) => {
    const state = userStates.get(jid);
    if (!state || !state.awaitingTeacherSelection) {
        console.log(`State not found or not awaiting teacher selection for ${jid}`);
        return;
    }

    const teacherIndex = parseInt(input) - 1;
    const teacher = Object.keys(state.unmarkedTeachersMap)[teacherIndex];

    if (!teacher) {
        await sendMessageWTyping({ text: 'Nomor guru tidak valid. Silakan coba lagi.' }, jid);
        console.log(`Invalid teacher number selected by ${jid}`);
        return;
    }

    const teacherDetails = state.unmarkedTeachersMap[teacher];

    // Log idjadwal dan kode_guru
    console.log(`Teacher selected by ${jid}: ${teacher}`);
    console.log(`idjadwal: ${teacherDetails.map(td => td.idjadwal).join(', ')}, kode_guru: ${state.kode_guru}`);

    // Query to get students in the class and save their attendance with status 'h'
    db.query('SELECT nisn, nama_siswa FROM siswa WHERE kelas = ?', [state.kelas], async (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            await sendMessageWTyping({ text: 'Terjadi kesalahan saat memeriksa absensi siswa.' }, jid);
            return;
        }

        if (results.length === 0) {
            console.log(`No students found for class ${state.kelas}`);
            await sendMessageWTyping({ text: 'Tidak ada siswa yang ditemukan di kelas ini.' }, jid);
            return;
        }

        const students = results;
        
        // Insert students' attendance with status 'h'
        const updates = students.flatMap(student => 
            teacherDetails.map(detail => ({
                idjadwal: detail.idjadwal,
                nisn: student.nisn,
                tanggal: new Date().toISOString().split('T')[0],
                jam: detail.jams, // Use the correct jam array for each detail
                status: 'h',
                kelas: state.kelas,
                kode_guru: state.kode_guru
            }))
        );

        const updateQuery = 'INSERT INTO absensi_siswa (idjadwal, nisn, tanggal, jam, status, kelas, kode_guru) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)';
        await Promise.all(updates.flatMap(record => {
            return record.jam.map(jam => {
                return new Promise((resolve, reject) => {
                    db.query(updateQuery, [record.idjadwal, record.nisn, record.tanggal, jam, record.status, record.kelas, record.kode_guru], (err, result) => {
                        if (err) {
                            console.error('Database update error:', err);
                            reject(err);
                        } else {
                            resolve(result);
                        }
                    });
                });
            });
        }));

        let studentAttendanceDetails = `Absensi siswa yang diajar oleh ${teacher}:\n`;
        students.forEach((student, index) => {
            studentAttendanceDetails += `${index + 1}. ${student.nama_siswa}\n`;
        });

        studentAttendanceDetails += '\nSilakan kirim nomor urut siswa yang tidak hadir dengan format: nomor urut#status sesuai jam.\nContoh: 1#ss (a:alpha, s:sakit, i:izin, t:terlambat)';

        await sendMessageWTyping({ text: studentAttendanceDetails }, jid);

        // Update the state to await student attendance input
        userStates.set(jid, { awaitingStudentAttendance: true, selectedTeacher: teacher, teacherDetails, unmarkedStudents: students, kelas: state.kelas, kode_guru: state.kode_guru });
        console.log(`State updated for ${jid} to await student attendance input`);
    });
};

const handleStudentAttendance = async (jid: string, input: string) => {
    const state = userStates.get(jid);
    if (!state || !state.awaitingStudentAttendance) return;

    const [studentIndex, status] = input.split('#');
    const studentPosition = parseInt(studentIndex) - 1;

    if (isNaN(studentPosition) || studentPosition < 0 || studentPosition >= state.unmarkedStudents.length) {
        await sendMessageWTyping({ text: 'Nomor urut siswa tidak valid. Silakan coba lagi.' }, jid);
        return;
    }

    const student = state.unmarkedStudents[studentPosition];

    if (!student || !status) {
        await sendMessageWTyping({ text: 'Format tidak valid. Silakan coba lagi dengan format: nomor urut#status sesuai jam.\nContoh: 1#ss (a:alpha, s:sakit, i:izin, t:terlambat)' }, jid);
        return;
    }

    const nisn = student.nisn;

    if (!nisn) {
        await sendMessageWTyping({ text: 'Terjadi kesalahan saat mengambil NISN siswa. Silakan coba lagi.' }, jid);
        return;
    }

    const teacherDetails = state.teacherDetails;

    if (status.length !== teacherDetails[0].jams.length) {
        await sendMessageWTyping({ text: 'Jumlah status tidak sesuai dengan jumlah jam. Silakan coba lagi.' }, jid);
        return;
    }

    console.log(`Processing attendance for student ${student.nama_siswa} by ${jid}`);
    // Update the attendance in the database
    const updates = teacherDetails[0].jams.map((jam, index) => ({
        idjadwal: teacherDetails[0].idjadwal,
        nisn: nisn,
        tanggal: new Date().toISOString().split('T')[0],
        jam: jam,
        status: status[index],
        kelas: state.kelas,
        kode_guru: state.kode_guru
    }));

    const updateQuery = 'INSERT INTO absensi_siswa (idjadwal, nisn, tanggal, jam, status, kelas, kode_guru) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status)';
    await Promise.all(updates.map(record => {
        return new Promise((resolve, reject) => {
            db.query(updateQuery, [record.idjadwal, record.nisn, record.tanggal, record.jam, record.status, record.kelas, record.kode_guru], (err, result) => {
                if (err) {
                    console.error('Database update error:', err);
                    reject(err);
                } else {
                    resolve(result);
                }
            });
        });
    }));

    await sendMessageWTyping({ text: `Status absensi siswa ${student.nama_siswa} telah diperbarui.` }, jid);

    console.log(`Attendance updated for student ${student.nama_siswa} by ${jid}`);
    // Remove the marked attendance from the list
    state.unmarkedStudents = state.unmarkedStudents.filter((s) => s.nisn !== nisn);

    if (state.unmarkedStudents.length === 0) {
        await sendMessageWTyping({ text: 'Semua siswa telah diabsen.' }, jid);
        userStates.delete(jid);
        console.log(`All students attendance completed by ${jid}`);
    } else {
        userStates.set(jid, { awaitingStudentAttendance: true, selectedTeacher: state.selectedTeacher, teacherDetails, unmarkedStudents: state.unmarkedStudents, kelas: state.kelas, kode_guru: state.kode_guru });
        console.log(`Awaiting further student attendance input from ${jid}`);
    }
};

const getNisnByName = async (name: string): Promise<string | null> => {
    return new Promise((resolve, reject) => {
        db.query('SELECT nisn FROM siswa WHERE nama_siswa = ?', [name], (err, results) => {
            if (err) {
                console.error('Database query error:', err);
                reject(null);
            } else {
                resolve(results.length > 0 ? results[0].nisn : null);
            }
        });
    });
};


sock.ev.process(async (events) => {
    if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        console.log('recv messages ', JSON.stringify(upsert, undefined, 2));

        if (upsert.type === 'notify') {
            for (const msg of upsert.messages) {
                if (!msg.key.fromMe) {
                    console.log('Received message from', msg.key.remoteJid, 'with text:', msg.message?.conversation);
                    const text = msg.message?.conversation?.toLowerCase() || msg.message?.extendedTextMessage?.text?.toLowerCase();
                    const locationMessage = msg.message?.locationMessage;
                    const imageMessage = msg.message?.imageMessage;
                    const stickerMessage = msg.message?.stickerMessage;

                    // Global check for #menu command
                    if (text === '#menu') {
                        await sendMenu(msg.key.remoteJid!);
                        continue; // Skip further processing for #menu command
                    }

                    // Global check for #back command
                    const state = userStates.get(msg.key.remoteJid!);
                    if (text === '#back' && state?.previousMenu) {
                        await state.previousMenu(msg.key.remoteJid!);
                        continue; // Skip further processing for #back command
                    }

                    try {
                        if (stickerMessage) {
                            await sendMenu(msg.key.remoteJid!);
                        } else if (text) {
                            console.log('Received text message:', text);
                            if (!msg.key.fromMe && !isJidNewsletter(msg.key.remoteJid!)) {
                                if (text === '#home') {
                                    await sendMenu(msg.key.remoteJid!);
                                } else if (text === '#1' || text === '#2' || text === '#3' || text === '#4' || text === '#5') {  // Tambahkan penanganan untuk #5
                                    await handleMenuSelection(text, msg.key.remoteJid!);
                                } else if (userStates.get(msg.key.remoteJid!)?.awaitingClassSelection) {
                                    await handleClassSelection(msg.key.remoteJid!, text);
                                } else if (userStates.get(msg.key.remoteJid!)?.awaitingAttendance) {
                                    await handleNonAttendanceSubmission(msg.key.remoteJid!, text);
                                } else if (userStates.get(msg.key.remoteJid!)?.awaitingClassAndMapelSelection) {
                                    await handleClassAndMapelSelection(msg.key.remoteJid!, text);
                                } else if (userStates.get(msg.key.remoteJid!)?.awaitingTeacherSelection) {
                                    console.log(`Processing teacher selection for ${msg.key.remoteJid}`);
                                    await handleTeacherSelection(msg.key.remoteJid!, text); // Ensure this handles teacher selection
                                } else if (userStates.get(msg.key.remoteJid!)?.awaitingStudentAttendance) {
                                    console.log(`Processing student attendance for ${msg.key.remoteJid}`);
                                    await handleStudentAttendance(msg.key.remoteJid!, text); // Ensure this handles student attendance
                                } else if (userStates.get(msg.key.remoteJid!)?.awaitingMenuSelection) {
                                    if (text === '#back') {
                                        await promptForClassSelection(msg.key.remoteJid!);
                                    } else {
                                        await sendMessageWTyping({ text: 'Perintah tidak dikenal. Ketik #back untuk ke awal menu pemilihan kelas yang diampu atau ketik #home jika ingin kembali ke menu utama.' }, msg.key.remoteJid!);
                                    }
                                } else {
                                    await sendMenu(msg.key.remoteJid!);
                                }
                            }
                        } else if (locationMessage && userStates.get(msg.key.remoteJid!)?.awaitingLocation) {
                            await handleLocationMessage(msg.key.remoteJid!, locationMessage);
                        } else {
                            await sendMessageWTyping({ text: 'Silakan kirim lokasi Anda dengan fitur share location WhatsApp.' }, msg.key.remoteJid!);
                        }
                    } catch (error) {
                        console.error('Error processing message:', error);
                        await sendMessageWTyping({ text: 'Terjadi kesalahan pada sistem. Silakan coba lagi.' }, msg.key.remoteJid!);
                    }
                }
            }
        }
    }
});
}
// Make sure to call startSock function
// Refresh the application every 15 minutes (900000 milliseconds)
setInterval(() => {
    console.log("Refreshing application...");
    // Add the refresh logic here. For example, you might want to restart certain processes or reinitialize certain states.
    // This is a placeholder:
    startSock();
}, 900000);
startSock();
