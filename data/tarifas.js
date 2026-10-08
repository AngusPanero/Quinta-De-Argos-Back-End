const VIGENCIA = { desde: "2026-10-02", hasta: "2030-10-01" };

const TARIFAS = {
  // ──────────────── Enero ────────────────
  "01-01": { precio: 374, minNoches: 2 }, // vie 01/01/2027 · Fecha especial
  "01-02": { precio: 300, minNoches: 2 }, // sáb 02/01/2027 · Sábado
  "01-03": { precio: 197, minNoches: 3 }, // dom 03/01/2027 · Domingo
  "01-04": { precio: 197, minNoches: 2 }, // lun 04/01/2027 · Fecha especial
  "01-05": { precio: 240, minNoches: 3 }, // mar 05/01/2027 · Martes
  "01-06": { precio: 197, minNoches: 3 }, // mié 06/01/2027 · Miércoles
  "01-07": { precio: 197, minNoches: 3 }, // jue 07/01/2027 · Jueves
  "01-08": { precio: 240, minNoches: 2 }, // vie 08/01/2027 · Viernes
  "01-09": { precio: 240, minNoches: 2 }, // sáb 09/01/2027 · Sábado
  "01-10": { precio: 197, minNoches: 3 }, // dom 10/01/2027 · Domingo
  "01-11": { precio: 197, minNoches: 3 }, // lun 11/01/2027 · Lunes
  "01-12": { precio: 197, minNoches: 3 }, // mar 12/01/2027 · Martes
  "01-13": { precio: 197, minNoches: 3 }, // mié 13/01/2027 · Miércoles
  "01-14": { precio: 197, minNoches: 3 }, // jue 14/01/2027 · Jueves
  "01-15": { precio: 240, minNoches: 2 }, // vie 15/01/2027 · Viernes
  "01-16": { precio: 240, minNoches: 2 }, // sáb 16/01/2027 · Sábado
  "01-17": { precio: 197, minNoches: 3 }, // dom 17/01/2027 · Domingo
  "01-18": { precio: 197, minNoches: 3 }, // lun 18/01/2027 · Lunes
  "01-19": { precio: 197, minNoches: 3 }, // mar 19/01/2027 · Martes
  "01-20": { precio: 197, minNoches: 3 }, // mié 20/01/2027 · Miércoles
  "01-21": { precio: 197, minNoches: 3 }, // jue 21/01/2027 · Jueves
  "01-22": { precio: 240, minNoches: 2 }, // vie 22/01/2027 · Viernes
  "01-23": { precio: 240, minNoches: 2 }, // sáb 23/01/2027 · Sábado
  "01-24": { precio: 197, minNoches: 3 }, // dom 24/01/2027 · Domingo
  "01-25": { precio: 197, minNoches: 3 }, // lun 25/01/2027 · Lunes
  "01-26": { precio: 197, minNoches: 3 }, // mar 26/01/2027 · Martes
  "01-27": { precio: 197, minNoches: 3 }, // mié 27/01/2027 · Miércoles
  "01-28": { precio: 197, minNoches: 3 }, // jue 28/01/2027 · Jueves
  "01-29": { precio: 240, minNoches: 2 }, // vie 29/01/2027 · Viernes
  "01-30": { precio: 240, minNoches: 2 }, // sáb 30/01/2027 · Sábado
  "01-31": { precio: 197, minNoches: 3 }, // dom 31/01/2027 · Domingo
  // ──────────────── Febrero ────────────────
  "02-01": { precio: 197, minNoches: 3 }, // lun 01/02/2027 · Lunes
  "02-02": { precio: 197, minNoches: 3 }, // mar 02/02/2027 · Martes
  "02-03": { precio: 197, minNoches: 3 }, // mié 03/02/2027 · Miércoles
  "02-04": { precio: 197, minNoches: 3 }, // jue 04/02/2027 · Jueves
  "02-05": { precio: 240, minNoches: 2 }, // vie 05/02/2027 · Viernes
  "02-06": { precio: 240, minNoches: 2 }, // sáb 06/02/2027 · Sábado
  "02-07": { precio: 197, minNoches: 3 }, // dom 07/02/2027 · Domingo
  "02-08": { precio: 197, minNoches: 3 }, // lun 08/02/2027 · Lunes
  "02-09": { precio: 197, minNoches: 3 }, // mar 09/02/2027 · Martes
  "02-10": { precio: 197, minNoches: 3 }, // mié 10/02/2027 · Miércoles
  "02-11": { precio: 197, minNoches: 3 }, // jue 11/02/2027 · Jueves
  "02-12": { precio: 240, minNoches: 2 }, // vie 12/02/2027 · Viernes
  "02-13": { precio: 240, minNoches: 2 }, // sáb 13/02/2027 · Sábado
  "02-14": { precio: 197, minNoches: 3 }, // dom 14/02/2027 · Domingo
  "02-15": { precio: 197, minNoches: 3 }, // lun 15/02/2027 · Lunes
  "02-16": { precio: 197, minNoches: 3 }, // mar 16/02/2027 · Martes
  "02-17": { precio: 197, minNoches: 3 }, // mié 17/02/2027 · Miércoles
  "02-18": { precio: 197, minNoches: 3 }, // jue 18/02/2027 · Jueves
  "02-19": { precio: 240, minNoches: 2 }, // vie 19/02/2027 · Viernes
  "02-20": { precio: 240, minNoches: 2 }, // sáb 20/02/2027 · Sábado
  "02-21": { precio: 197, minNoches: 3 }, // dom 21/02/2027 · Domingo
  "02-22": { precio: 197, minNoches: 3 }, // lun 22/02/2027 · Lunes
  "02-23": { precio: 197, minNoches: 3 }, // mar 23/02/2027 · Martes
  "02-24": { precio: 197, minNoches: 3 }, // mié 24/02/2027 · Miércoles
  "02-25": { precio: 197, minNoches: 3 }, // jue 25/02/2027 · Jueves
  "02-26": { precio: 240, minNoches: 2 }, // vie 26/02/2027 · Viernes
  "02-27": { precio: 240, minNoches: 2 }, // sáb 27/02/2027 · Sábado
  "02-28": { precio: 197, minNoches: 3 }, // dom 28/02/2027 · Domingo
  "02-29": { precio: 197, minNoches: 3 }, // PENDIENTE: solo existe en años bisiestos (2028); no está en el Excel
  // ──────────────── Marzo ────────────────
  "03-01": { precio: 197, minNoches: 3 }, // lun 01/03/2027 · Lunes
  "03-02": { precio: 197, minNoches: 3 }, // mar 02/03/2027 · Martes
  "03-03": { precio: 197, minNoches: 3 }, // mié 03/03/2027 · Miércoles
  "03-04": { precio: 197, minNoches: 3 }, // jue 04/03/2027 · Jueves
  "03-05": { precio: 240, minNoches: 2 }, // vie 05/03/2027 · Viernes
  "03-06": { precio: 240, minNoches: 2 }, // sáb 06/03/2027 · Sábado
  "03-07": { precio: 197, minNoches: 3 }, // dom 07/03/2027 · Domingo
  "03-08": { precio: 197, minNoches: 3 }, // lun 08/03/2027 · Lunes
  "03-09": { precio: 197, minNoches: 3 }, // mar 09/03/2027 · Martes
  "03-10": { precio: 197, minNoches: 3 }, // mié 10/03/2027 · Miércoles
  "03-11": { precio: 197, minNoches: 3 }, // jue 11/03/2027 · Jueves
  "03-12": { precio: 240, minNoches: 2 }, // vie 12/03/2027 · Viernes
  "03-13": { precio: 240, minNoches: 2 }, // sáb 13/03/2027 · Sábado
  "03-14": { precio: 197, minNoches: 3 }, // dom 14/03/2027 · Domingo
  "03-15": { precio: 197, minNoches: 3 }, // lun 15/03/2027 · Lunes
  "03-16": { precio: 197, minNoches: 3 }, // mar 16/03/2027 · Martes
  "03-17": { precio: 197, minNoches: 3 }, // mié 17/03/2027 · Miércoles
  "03-18": { precio: 240, minNoches: 3 }, // jue 18/03/2027 · Fecha especial
  "03-19": { precio: 240, minNoches: 2 }, // vie 19/03/2027 · Viernes
  "03-20": { precio: 240, minNoches: 2 }, // sáb 20/03/2027 · Sábado
  "03-21": { precio: 197, minNoches: 3 }, // dom 21/03/2027 · Domingo
  "03-22": { precio: 197, minNoches: 3 }, // lun 22/03/2027 · Lunes
  "03-23": { precio: 197, minNoches: 5 }, // mar 23/03/2027 · Fecha especial
  "03-24": { precio: 240, minNoches: 4 }, // mié 24/03/2027 · Fecha especial
  "03-25": { precio: 240, minNoches: 3 }, // jue 25/03/2027 · Fecha especial
  "03-26": { precio: 240, minNoches: 2 }, // vie 26/03/2027 · Fecha especial
  "03-27": { precio: 240, minNoches: 2 }, // sáb 27/03/2027 · Sábado
  "03-28": { precio: 240, minNoches: 3 }, // dom 28/03/2027 · Domingo
  "03-29": { precio: 240, minNoches: 3 }, // lun 29/03/2027 · Lunes
  "03-30": { precio: 197, minNoches: 3 }, // mar 30/03/2027 · Martes
  "03-31": { precio: 197, minNoches: 3 }, // mié 31/03/2027 · Miércoles
  // ──────────────── Abril ────────────────
  "04-01": { precio: 197, minNoches: 3 }, // jue 01/04/2027 · Jueves
  "04-02": { precio: 240, minNoches: 2 }, // vie 02/04/2027 · Viernes
  "04-03": { precio: 240, minNoches: 2 }, // sáb 03/04/2027 · Sábado
  "04-04": { precio: 197, minNoches: 3 }, // dom 04/04/2027 · Domingo
  "04-05": { precio: 197, minNoches: 3 }, // lun 05/04/2027 · Lunes
  "04-06": { precio: 197, minNoches: 3 }, // mar 06/04/2027 · Martes
  "04-07": { precio: 197, minNoches: 3 }, // mié 07/04/2027 · Miércoles
  "04-08": { precio: 197, minNoches: 3 }, // jue 08/04/2027 · Jueves
  "04-09": { precio: 240, minNoches: 2 }, // vie 09/04/2027 · Viernes
  "04-10": { precio: 240, minNoches: 2 }, // sáb 10/04/2027 · Sábado
  "04-11": { precio: 197, minNoches: 3 }, // dom 11/04/2027 · Domingo
  "04-12": { precio: 197, minNoches: 3 }, // lun 12/04/2027 · Lunes
  "04-13": { precio: 197, minNoches: 3 }, // mar 13/04/2027 · Martes
  "04-14": { precio: 197, minNoches: 3 }, // mié 14/04/2027 · Miércoles
  "04-15": { precio: 197, minNoches: 3 }, // jue 15/04/2027 · Jueves
  "04-16": { precio: 240, minNoches: 2 }, // vie 16/04/2027 · Viernes
  "04-17": { precio: 240, minNoches: 2 }, // sáb 17/04/2027 · Sábado
  "04-18": { precio: 197, minNoches: 3 }, // dom 18/04/2027 · Domingo
  "04-19": { precio: 197, minNoches: 3 }, // lun 19/04/2027 · Lunes
  "04-20": { precio: 197, minNoches: 3 }, // mar 20/04/2027 · Martes
  "04-21": { precio: 197, minNoches: 3 }, // mié 21/04/2027 · Miércoles
  "04-22": { precio: 197, minNoches: 3 }, // jue 22/04/2027 · Jueves
  "04-23": { precio: 240, minNoches: 2 }, // vie 23/04/2027 · Viernes
  "04-24": { precio: 240, minNoches: 2 }, // sáb 24/04/2027 · Sábado
  "04-25": { precio: 197, minNoches: 3 }, // dom 25/04/2027 · Domingo
  "04-26": { precio: 197, minNoches: 3 }, // lun 26/04/2027 · Lunes
  "04-27": { precio: 197, minNoches: 3 }, // mar 27/04/2027 · Martes
  "04-28": { precio: 197, minNoches: 3 }, // mié 28/04/2027 · Miércoles
  "04-29": { precio: 197, minNoches: 3 }, // jue 29/04/2027 · Jueves
  "04-30": { precio: 240, minNoches: 2 }, // vie 30/04/2027 · Viernes
  // ──────────────── Mayo ────────────────
  "05-01": { precio: 240, minNoches: 2 }, // sáb 01/05/2027 · Sábado
  "05-02": { precio: 197, minNoches: 3 }, // dom 02/05/2027 · Domingo
  "05-03": { precio: 197, minNoches: 3 }, // lun 03/05/2027 · Lunes
  "05-04": { precio: 197, minNoches: 3 }, // mar 04/05/2027 · Martes
  "05-05": { precio: 197, minNoches: 3 }, // mié 05/05/2027 · Miércoles
  "05-06": { precio: 197, minNoches: 3 }, // jue 06/05/2027 · Jueves
  "05-07": { precio: 240, minNoches: 2 }, // vie 07/05/2027 · Viernes
  "05-08": { precio: 240, minNoches: 2 }, // sáb 08/05/2027 · Sábado
  "05-09": { precio: 197, minNoches: 3 }, // dom 09/05/2027 · Domingo
  "05-10": { precio: 197, minNoches: 3 }, // lun 10/05/2027 · Lunes
  "05-11": { precio: 197, minNoches: 3 }, // mar 11/05/2027 · Martes
  "05-12": { precio: 197, minNoches: 3 }, // mié 12/05/2027 · Miércoles
  "05-13": { precio: 197, minNoches: 3 }, // jue 13/05/2027 · Jueves
  "05-14": { precio: 240, minNoches: 2 }, // vie 14/05/2027 · Viernes
  "05-15": { precio: 240, minNoches: 2 }, // sáb 15/05/2027 · Sábado
  "05-16": { precio: 197, minNoches: 3 }, // dom 16/05/2027 · Domingo
  "05-17": { precio: 197, minNoches: 3 }, // lun 17/05/2027 · Lunes
  "05-18": { precio: 197, minNoches: 3 }, // mar 18/05/2027 · Martes
  "05-19": { precio: 197, minNoches: 3 }, // mié 19/05/2027 · Miércoles
  "05-20": { precio: 197, minNoches: 3 }, // jue 20/05/2027 · Jueves
  "05-21": { precio: 240, minNoches: 2 }, // vie 21/05/2027 · Viernes
  "05-22": { precio: 240, minNoches: 2 }, // sáb 22/05/2027 · Sábado
  "05-23": { precio: 197, minNoches: 3 }, // dom 23/05/2027 · Domingo
  "05-24": { precio: 197, minNoches: 3 }, // lun 24/05/2027 · Lunes
  "05-25": { precio: 197, minNoches: 3 }, // mar 25/05/2027 · Martes
  "05-26": { precio: 197, minNoches: 3 }, // mié 26/05/2027 · Miércoles
  "05-27": { precio: 197, minNoches: 3 }, // jue 27/05/2027 · Jueves
  "05-28": { precio: 240, minNoches: 2 }, // vie 28/05/2027 · Viernes
  "05-29": { precio: 240, minNoches: 2 }, // sáb 29/05/2027 · Sábado
  "05-30": { precio: 197, minNoches: 3 }, // dom 30/05/2027 · Domingo
  "05-31": { precio: 197, minNoches: 3 }, // lun 31/05/2027 · Lunes
  // ──────────────── Junio ────────────────
  "06-01": { precio: 240, minNoches: 4 }, // mar 01/06/2027 · Junio y septiembre
  "06-02": { precio: 240, minNoches: 4 }, // mié 02/06/2027 · Junio y septiembre
  "06-03": { precio: 240, minNoches: 4 }, // jue 03/06/2027 · Junio y septiembre
  "06-04": { precio: 267, minNoches: 4 }, // vie 04/06/2027 · Junio y septiembre
  "06-05": { precio: 267, minNoches: 4 }, // sáb 05/06/2027 · Junio y septiembre
  "06-06": { precio: 240, minNoches: 4 }, // dom 06/06/2027 · Junio y septiembre
  "06-07": { precio: 240, minNoches: 4 }, // lun 07/06/2027 · Junio y septiembre
  "06-08": { precio: 240, minNoches: 4 }, // mar 08/06/2027 · Junio y septiembre
  "06-09": { precio: 240, minNoches: 4 }, // mié 09/06/2027 · Junio y septiembre
  "06-10": { precio: 240, minNoches: 4 }, // jue 10/06/2027 · Junio y septiembre
  "06-11": { precio: 267, minNoches: 4 }, // vie 11/06/2027 · Junio y septiembre
  "06-12": { precio: 267, minNoches: 4 }, // sáb 12/06/2027 · Junio y septiembre
  "06-13": { precio: 240, minNoches: 4 }, // dom 13/06/2027 · Junio y septiembre
  "06-14": { precio: 240, minNoches: 4 }, // lun 14/06/2027 · Junio y septiembre
  "06-15": { precio: 240, minNoches: 4 }, // mar 15/06/2027 · Junio y septiembre
  "06-16": { precio: 240, minNoches: 4 }, // mié 16/06/2027 · Junio y septiembre
  "06-17": { precio: 240, minNoches: 4 }, // jue 17/06/2027 · Junio y septiembre
  "06-18": { precio: 267, minNoches: 4 }, // vie 18/06/2027 · Junio y septiembre
  "06-19": { precio: 267, minNoches: 4 }, // sáb 19/06/2027 · Junio y septiembre
  "06-20": { precio: 240, minNoches: 4 }, // dom 20/06/2027 · Junio y septiembre
  "06-21": { precio: 240, minNoches: 4 }, // lun 21/06/2027 · Junio y septiembre
  "06-22": { precio: 240, minNoches: 4 }, // mar 22/06/2027 · Junio y septiembre
  "06-23": { precio: 240, minNoches: 4 }, // mié 23/06/2027 · Junio y septiembre
  "06-24": { precio: 240, minNoches: 4 }, // jue 24/06/2027 · Junio y septiembre
  "06-25": { precio: 267, minNoches: 4 }, // vie 25/06/2027 · Junio y septiembre
  "06-26": { precio: 267, minNoches: 4 }, // sáb 26/06/2027 · Junio y septiembre
  "06-27": { precio: 255, minNoches: 4 }, // dom 27/06/2027 · Junio y septiembre
  "06-28": { precio: 240, minNoches: 4 }, // lun 28/06/2027 · Junio y septiembre
  "06-29": { precio: 240, minNoches: 4 }, // mar 29/06/2027 · Junio y septiembre
  "06-30": { precio: 240, minNoches: 4 }, // mié 30/06/2027 · Junio y septiembre
  // ──────────────── Julio ────────────────
  "07-01": { precio: 267, minNoches: 7 }, // jue 01/07/2027 · Julio y agosto
  "07-02": { precio: 267, minNoches: 7 }, // vie 02/07/2027 · Julio y agosto
  "07-03": { precio: 267, minNoches: 7 }, // sáb 03/07/2027 · Julio y agosto
  "07-04": { precio: 267, minNoches: 7 }, // dom 04/07/2027 · Julio y agosto
  "07-05": { precio: 267, minNoches: 7 }, // lun 05/07/2027 · Julio y agosto
  "07-06": { precio: 267, minNoches: 7 }, // mar 06/07/2027 · Julio y agosto
  "07-07": { precio: 267, minNoches: 7 }, // mié 07/07/2027 · Julio y agosto
  "07-08": { precio: 267, minNoches: 7 }, // jue 08/07/2027 · Julio y agosto
  "07-09": { precio: 267, minNoches: 7 }, // vie 09/07/2027 · Julio y agosto
  "07-10": { precio: 267, minNoches: 7 }, // sáb 10/07/2027 · Julio y agosto
  "07-11": { precio: 267, minNoches: 7 }, // dom 11/07/2027 · Julio y agosto
  "07-12": { precio: 267, minNoches: 7 }, // lun 12/07/2027 · Julio y agosto
  "07-13": { precio: 267, minNoches: 7 }, // mar 13/07/2027 · Julio y agosto
  "07-14": { precio: 267, minNoches: 7 }, // mié 14/07/2027 · Julio y agosto
  "07-15": { precio: 267, minNoches: 7 }, // jue 15/07/2027 · Julio y agosto
  "07-16": { precio: 267, minNoches: 7 }, // vie 16/07/2027 · Julio y agosto
  "07-17": { precio: 267, minNoches: 7 }, // sáb 17/07/2027 · Julio y agosto
  "07-18": { precio: 267, minNoches: 7 }, // dom 18/07/2027 · Julio y agosto
  "07-19": { precio: 267, minNoches: 7 }, // lun 19/07/2027 · Julio y agosto
  "07-20": { precio: 267, minNoches: 7 }, // mar 20/07/2027 · Julio y agosto
  "07-21": { precio: 267, minNoches: 7 }, // mié 21/07/2027 · Julio y agosto
  "07-22": { precio: 267, minNoches: 7 }, // jue 22/07/2027 · Julio y agosto
  "07-23": { precio: 267, minNoches: 7 }, // vie 23/07/2027 · Julio y agosto
  "07-24": { precio: 267, minNoches: 7 }, // sáb 24/07/2027 · Julio y agosto
  "07-25": { precio: 267, minNoches: 7 }, // dom 25/07/2027 · Julio y agosto
  "07-26": { precio: 267, minNoches: 7 }, // lun 26/07/2027 · Julio y agosto
  "07-27": { precio: 267, minNoches: 7 }, // mar 27/07/2027 · Julio y agosto
  "07-28": { precio: 267, minNoches: 7 }, // mié 28/07/2027 · Julio y agosto
  "07-29": { precio: 267, minNoches: 7 }, // jue 29/07/2027 · Julio y agosto
  "07-30": { precio: 267, minNoches: 7 }, // vie 30/07/2027 · Julio y agosto
  "07-31": { precio: 267, minNoches: 7 }, // sáb 31/07/2027 · Julio y agosto
  // ──────────────── Agosto ────────────────
  "08-01": { precio: 267, minNoches: 7 }, // dom 01/08/2027 · Julio y agosto
  "08-02": { precio: 267, minNoches: 7 }, // lun 02/08/2027 · Julio y agosto
  "08-03": { precio: 267, minNoches: 7 }, // mar 03/08/2027 · Julio y agosto
  "08-04": { precio: 267, minNoches: 7 }, // mié 04/08/2027 · Julio y agosto
  "08-05": { precio: 267, minNoches: 7 }, // jue 05/08/2027 · Julio y agosto
  "08-06": { precio: 267, minNoches: 7 }, // vie 06/08/2027 · Julio y agosto
  "08-07": { precio: 267, minNoches: 7 }, // sáb 07/08/2027 · Julio y agosto
  "08-08": { precio: 267, minNoches: 7 }, // dom 08/08/2027 · Julio y agosto
  "08-09": { precio: 267, minNoches: 7 }, // lun 09/08/2027 · Julio y agosto
  "08-10": { precio: 267, minNoches: 7 }, // mar 10/08/2027 · Julio y agosto
  "08-11": { precio: 267, minNoches: 7 }, // mié 11/08/2027 · Julio y agosto
  "08-12": { precio: 267, minNoches: 7 }, // jue 12/08/2027 · Julio y agosto
  "08-13": { precio: 267, minNoches: 7 }, // vie 13/08/2027 · Julio y agosto
  "08-14": { precio: 267, minNoches: 7 }, // sáb 14/08/2027 · Julio y agosto
  "08-15": { precio: 267, minNoches: 7 }, // dom 15/08/2027 · Julio y agosto
  "08-16": { precio: 267, minNoches: 7 }, // lun 16/08/2027 · Julio y agosto
  "08-17": { precio: 267, minNoches: 7 }, // mar 17/08/2027 · Julio y agosto
  "08-18": { precio: 267, minNoches: 7 }, // mié 18/08/2027 · Julio y agosto
  "08-19": { precio: 267, minNoches: 7 }, // jue 19/08/2027 · Julio y agosto
  "08-20": { precio: 267, minNoches: 7 }, // vie 20/08/2027 · Julio y agosto
  "08-21": { precio: 267, minNoches: 7 }, // sáb 21/08/2027 · Julio y agosto
  "08-22": { precio: 267, minNoches: 7 }, // dom 22/08/2027 · Julio y agosto
  "08-23": { precio: 267, minNoches: 7 }, // lun 23/08/2027 · Julio y agosto
  "08-24": { precio: 267, minNoches: 7 }, // mar 24/08/2027 · Julio y agosto
  "08-25": { precio: 267, minNoches: 7 }, // mié 25/08/2027 · Julio y agosto
  "08-26": { precio: 267, minNoches: 7 }, // jue 26/08/2027 · Julio y agosto
  "08-27": { precio: 267, minNoches: 7 }, // vie 27/08/2027 · Julio y agosto
  "08-28": { precio: 267, minNoches: 7 }, // sáb 28/08/2027 · Julio y agosto
  "08-29": { precio: 267, minNoches: 7 }, // dom 29/08/2027 · Julio y agosto
  "08-30": { precio: 267, minNoches: 7 }, // lun 30/08/2027 · Julio y agosto
  "08-31": { precio: 267, minNoches: 7 }, // mar 31/08/2027 · Julio y agosto
  // ──────────────── Septiembre ────────────────
  "09-01": { precio: 240, minNoches: 4 }, // mié 01/09/2027 · Junio y septiembre
  "09-02": { precio: 240, minNoches: 4 }, // jue 02/09/2027 · Junio y septiembre
  "09-03": { precio: 267, minNoches: 4 }, // vie 03/09/2027 · Junio y septiembre
  "09-04": { precio: 267, minNoches: 4 }, // sáb 04/09/2027 · Junio y septiembre
  "09-05": { precio: 240, minNoches: 4 }, // dom 05/09/2027 · Junio y septiembre
  "09-06": { precio: 240, minNoches: 4 }, // lun 06/09/2027 · Junio y septiembre
  "09-07": { precio: 240, minNoches: 4 }, // mar 07/09/2027 · Junio y septiembre
  "09-08": { precio: 240, minNoches: 4 }, // mié 08/09/2027 · Junio y septiembre
  "09-09": { precio: 240, minNoches: 4 }, // jue 09/09/2027 · Junio y septiembre
  "09-10": { precio: 267, minNoches: 4 }, // vie 10/09/2027 · Junio y septiembre
  "09-11": { precio: 267, minNoches: 4 }, // sáb 11/09/2027 · Junio y septiembre
  "09-12": { precio: 240, minNoches: 4 }, // dom 12/09/2027 · Junio y septiembre
  "09-13": { precio: 240, minNoches: 4 }, // lun 13/09/2027 · Junio y septiembre
  "09-14": { precio: 240, minNoches: 4 }, // mar 14/09/2027 · Junio y septiembre
  "09-15": { precio: 240, minNoches: 4 }, // mié 15/09/2027 · Junio y septiembre
  "09-16": { precio: 240, minNoches: 4 }, // jue 16/09/2027 · Junio y septiembre
  "09-17": { precio: 267, minNoches: 4 }, // vie 17/09/2027 · Junio y septiembre
  "09-18": { precio: 267, minNoches: 4 }, // sáb 18/09/2027 · Junio y septiembre
  "09-19": { precio: 240, minNoches: 4 }, // dom 19/09/2027 · Junio y septiembre
  "09-20": { precio: 240, minNoches: 4 }, // lun 20/09/2027 · Junio y septiembre
  "09-21": { precio: 240, minNoches: 4 }, // mar 21/09/2027 · Junio y septiembre
  "09-22": { precio: 240, minNoches: 4 }, // mié 22/09/2027 · Junio y septiembre
  "09-23": { precio: 240, minNoches: 4 }, // jue 23/09/2027 · Junio y septiembre
  "09-24": { precio: 267, minNoches: 4 }, // vie 24/09/2027 · Junio y septiembre
  "09-25": { precio: 267, minNoches: 4 }, // sáb 25/09/2027 · Junio y septiembre
  "09-26": { precio: 240, minNoches: 4 }, // dom 26/09/2027 · Junio y septiembre
  "09-27": { precio: 240, minNoches: 4 }, // lun 27/09/2027 · Junio y septiembre
  "09-28": { precio: 240, minNoches: 4 }, // mar 28/09/2027 · Junio y septiembre
  "09-29": { precio: 240, minNoches: 4 }, // PENDIENTE: sin precio en el Excel (mié 29/09/2027 · Junio y septiembre)
  "09-30": { precio: 240, minNoches: 4 }, // PENDIENTE: sin precio en el Excel (jue 30/09/2027 · Junio y septiembre)
  // ──────────────── Octubre ────────────────
  "10-01": { precio: 240, minNoches: 2 }, // PENDIENTE: sin precio en el Excel (vie 01/10/2027 · Viernes)
  "10-02": { precio: 240, minNoches: 2 }, // vie 02/10/2026 · Viernes
  "10-03": { precio: 240, minNoches: 2 }, // sáb 03/10/2026 · Sábado
  "10-04": { precio: 197, minNoches: 3 }, // dom 04/10/2026 · Domingo
  "10-05": { precio: 197, minNoches: 3 }, // lun 05/10/2026 · Lunes
  "10-06": { precio: 197, minNoches: 3 }, // mar 06/10/2026 · Martes
  "10-07": { precio: 197, minNoches: 3 }, // mié 07/10/2026 · Miércoles
  "10-08": { precio: 197, minNoches: 4 }, // jue 08/10/2026 · Fecha especial
  "10-09": { precio: 240, minNoches: 3 }, // vie 09/10/2026 · Fecha especial
  "10-10": { precio: 240, minNoches: 2 }, // sáb 10/10/2026 · Fecha especial
  "10-11": { precio: 240, minNoches: 3 }, // dom 11/10/2026 · Domingo
  "10-12": { precio: 197, minNoches: 3 }, // lun 12/10/2026 · Lunes
  "10-13": { precio: 197, minNoches: 3 }, // mar 13/10/2026 · Martes
  "10-14": { precio: 197, minNoches: 3 }, // mié 14/10/2026 · Miércoles
  "10-15": { precio: 197, minNoches: 3 }, // jue 15/10/2026 · Jueves
  "10-16": { precio: 240, minNoches: 2 }, // vie 16/10/2026 · Viernes
  "10-17": { precio: 240, minNoches: 2 }, // sáb 17/10/2026 · Sábado
  "10-18": { precio: 197, minNoches: 3 }, // dom 18/10/2026 · Domingo
  "10-19": { precio: 197, minNoches: 3 }, // lun 19/10/2026 · Lunes
  "10-20": { precio: 197, minNoches: 3 }, // mar 20/10/2026 · Martes
  "10-21": { precio: 197, minNoches: 3 }, // mié 21/10/2026 · Miércoles
  "10-22": { precio: 197, minNoches: 3 }, // jue 22/10/2026 · Jueves
  "10-23": { precio: 240, minNoches: 2 }, // vie 23/10/2026 · Viernes
  "10-24": { precio: 240, minNoches: 2 }, // sáb 24/10/2026 · Sábado
  "10-25": { precio: 197, minNoches: 3 }, // dom 25/10/2026 · Domingo
  "10-26": { precio: 197, minNoches: 3 }, // lun 26/10/2026 · Lunes
  "10-27": { precio: 197, minNoches: 3 }, // mar 27/10/2026 · Martes
  "10-28": { precio: 197, minNoches: 3 }, // mié 28/10/2026 · Miércoles
  "10-29": { precio: 197, minNoches: 3 }, // jue 29/10/2026 · Jueves
  "10-30": { precio: 240, minNoches: 2 }, // vie 30/10/2026 · Viernes
  "10-31": { precio: 326, minNoches: 2 }, // sáb 31/10/2026 · Sábado
  // ──────────────── Noviembre ────────────────
  "11-01": { precio: 197, minNoches: 3 }, // dom 01/11/2026 · Domingo
  "11-02": { precio: 197, minNoches: 3 }, // lun 02/11/2026 · Lunes
  "11-03": { precio: 197, minNoches: 3 }, // mar 03/11/2026 · Martes
  "11-04": { precio: 197, minNoches: 3 }, // mié 04/11/2026 · Miércoles
  "11-05": { precio: 197, minNoches: 3 }, // jue 05/11/2026 · Jueves
  "11-06": { precio: 240, minNoches: 2 }, // vie 06/11/2026 · Viernes
  "11-07": { precio: 240, minNoches: 2 }, // sáb 07/11/2026 · Sábado
  "11-08": { precio: 197, minNoches: 3 }, // dom 08/11/2026 · Domingo
  "11-09": { precio: 197, minNoches: 3 }, // lun 09/11/2026 · Lunes
  "11-10": { precio: 197, minNoches: 3 }, // mar 10/11/2026 · Martes
  "11-11": { precio: 197, minNoches: 3 }, // mié 11/11/2026 · Miércoles
  "11-12": { precio: 197, minNoches: 3 }, // jue 12/11/2026 · Jueves
  "11-13": { precio: 240, minNoches: 2 }, // vie 13/11/2026 · Viernes
  "11-14": { precio: 240, minNoches: 2 }, // sáb 14/11/2026 · Sábado
  "11-15": { precio: 197, minNoches: 3 }, // dom 15/11/2026 · Domingo
  "11-16": { precio: 197, minNoches: 3 }, // lun 16/11/2026 · Lunes
  "11-17": { precio: 197, minNoches: 3 }, // mar 17/11/2026 · Martes
  "11-18": { precio: 197, minNoches: 3 }, // mié 18/11/2026 · Miércoles
  "11-19": { precio: 197, minNoches: 3 }, // jue 19/11/2026 · Jueves
  "11-20": { precio: 240, minNoches: 2 }, // vie 20/11/2026 · Viernes
  "11-21": { precio: 240, minNoches: 2 }, // sáb 21/11/2026 · Sábado
  "11-22": { precio: 197, minNoches: 3 }, // dom 22/11/2026 · Domingo
  "11-23": { precio: 197, minNoches: 3 }, // lun 23/11/2026 · Lunes
  "11-24": { precio: 197, minNoches: 3 }, // mar 24/11/2026 · Martes
  "11-25": { precio: 197, minNoches: 3 }, // mié 25/11/2026 · Miércoles
  "11-26": { precio: 197, minNoches: 3 }, // jue 26/11/2026 · Jueves
  "11-27": { precio: 240, minNoches: 2 }, // vie 27/11/2026 · Viernes
  "11-28": { precio: 240, minNoches: 2 }, // sáb 28/11/2026 · Sábado
  "11-29": { precio: 197, minNoches: 3 }, // dom 29/11/2026 · Domingo
  "11-30": { precio: 197, minNoches: 3 }, // lun 30/11/2026 · Lunes
  // ──────────────── Diciembre ────────────────
  "12-01": { precio: 197, minNoches: 3 }, // mar 01/12/2026 · Martes
  "12-02": { precio: 197, minNoches: 3 }, // mié 02/12/2026 · Miércoles
  "12-03": { precio: 197, minNoches: 3 }, // jue 03/12/2026 · Jueves
  "12-04": { precio: 240, minNoches: 4 }, // vie 04/12/2026 · Fecha especial
  "12-05": { precio: 326, minNoches: 3 }, // sáb 05/12/2026 · Fecha especial
  "12-06": { precio: 197, minNoches: 2 }, // dom 06/12/2026 · Fecha especial
  "12-07": { precio: 326, minNoches: 3 }, // lun 07/12/2026 · Lunes
  "12-08": { precio: 197, minNoches: 3 }, // mar 08/12/2026 · Martes
  "12-09": { precio: 197, minNoches: 3 }, // mié 09/12/2026 · Miércoles
  "12-10": { precio: 197, minNoches: 3 }, // jue 10/12/2026 · Jueves
  "12-11": { precio: 240, minNoches: 2 }, // vie 11/12/2026 · Viernes
  "12-12": { precio: 240, minNoches: 2 }, // sáb 12/12/2026 · Sábado
  "12-13": { precio: 197, minNoches: 3 }, // dom 13/12/2026 · Domingo
  "12-14": { precio: 197, minNoches: 3 }, // lun 14/12/2026 · Lunes
  "12-15": { precio: 197, minNoches: 3 }, // mar 15/12/2026 · Martes
  "12-16": { precio: 197, minNoches: 3 }, // mié 16/12/2026 · Miércoles
  "12-17": { precio: 197, minNoches: 3 }, // jue 17/12/2026 · Jueves
  "12-18": { precio: 240, minNoches: 2 }, // vie 18/12/2026 · Viernes
  "12-19": { precio: 240, minNoches: 2 }, // sáb 19/12/2026 · Sábado
  "12-20": { precio: 197, minNoches: 3 }, // dom 20/12/2026 · Domingo
  "12-21": { precio: 197, minNoches: 3 }, // lun 21/12/2026 · Lunes
  "12-22": { precio: 197, minNoches: 3 }, // mar 22/12/2026 · Martes
  "12-23": { precio: 197, minNoches: 4 }, // mié 23/12/2026 · Fecha especial
  "12-24": { precio: 395, minNoches: 3 }, // jue 24/12/2026 · Jueves
  "12-25": { precio: 374, minNoches: 2 }, // vie 25/12/2026 · Viernes
  "12-26": { precio: 300, minNoches: 2 }, // sáb 26/12/2026 · Sábado
  "12-27": { precio: 240, minNoches: 3 }, // dom 27/12/2026 · Domingo
  "12-28": { precio: 240, minNoches: 4 }, // lun 28/12/2026 · Fecha especial
  "12-29": { precio: 240, minNoches: 3 }, // mar 29/12/2026 · Martes
  "12-30": { precio: 240, minNoches: 3 }, // mié 30/12/2026 · Fecha especial
  "12-31": { precio: 395, minNoches: 3 }, // jue 31/12/2026 · Fecha especial
};

module.exports = { VIGENCIA, TARIFAS };