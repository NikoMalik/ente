// The code in this file is deprecated and meant to be deleted.
//
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import log from "@/base/log";
import { type FileTypeInfo } from "@/media/file-type";
import { NULL_LOCATION } from "@/new/photos/services/upload/types";
import type {
    Location,
    ParsedExtractedMetadata,
} from "@/new/photos/types/metadata";
import { validateAndGetCreationUnixTimeInMicroSeconds } from "@ente/shared/time";
import exifr from "exifr";

type ParsedEXIFData = Record<string, any> &
    Partial<{
        DateTimeOriginal: Date;
        CreateDate: Date;
        ModifyDate: Date;
        DateCreated: Date;
        MetadataDate: Date;
        latitude: number;
        longitude: number;
        imageWidth: number;
        imageHeight: number;
    }>;

type RawEXIFData = Record<string, any> &
    Partial<{
        DateTimeOriginal: string;
        CreateDate: string;
        ModifyDate: string;
        DateCreated: string;
        MetadataDate: string;
        GPSLatitude: number[];
        GPSLongitude: number[];
        GPSLatitudeRef: string;
        GPSLongitudeRef: string;
        ImageWidth: number;
        ImageHeight: number;
    }>;

const exifTagsNeededForParsingImageMetadata = [
    "DateTimeOriginal",
    "CreateDate",
    "ModifyDate",
    "GPSLatitude",
    "GPSLongitude",
    "GPSLatitudeRef",
    "GPSLongitudeRef",
    "DateCreated",
    "ExifImageWidth",
    "ExifImageHeight",
    "ImageWidth",
    "ImageHeight",
    "PixelXDimension",
    "PixelYDimension",
    "MetadataDate",
];

/**
 * Read Exif data from an image {@link file} and use that to construct and
 * return an {@link ParsedExtractedMetadata}.
 *
 * This function is tailored for use when we upload files.
 */
export const parseImageMetadata = async (
    file: File,
    fileTypeInfo: FileTypeInfo,
): Promise<ParsedExtractedMetadata> => {
    const exifData = await getParsedExifData(
        file,
        fileTypeInfo,
        exifTagsNeededForParsingImageMetadata,
    );

    // TODO: Exif- remove me.
    log.debug(() => ["exif/old", exifData]);
    return {
        location: getEXIFLocation(exifData),
        creationTime: getEXIFTime(exifData),
        width: exifData?.imageWidth ?? null,
        height: exifData?.imageHeight ?? null,
    };
};

export async function getParsedExifData(
    receivedFile: File,
    { extension }: FileTypeInfo,
    tags?: string[],
): Promise<ParsedEXIFData> {
    const exifLessFormats = ["gif", "bmp"];
    const exifrUnsupportedFileFormatMessage = "Unknown file format";

    try {
        if (exifLessFormats.includes(extension)) return null;

        const exifData: RawEXIFData = await exifr.parse(receivedFile, {
            reviveValues: false,
            tiff: true,
            xmp: true,
            icc: true,
            iptc: true,
            jfif: true,
            ihdr: true,
        });
        if (!exifData) {
            return null;
        }
        const filteredExifData = tags
            ? Object.fromEntries(
                  Object.entries(exifData).filter(([key]) =>
                      tags.includes(key),
                  ),
              )
            : exifData;
        return parseExifData(filteredExifData);
    } catch (e) {
        if (e.message == exifrUnsupportedFileFormatMessage) {
            log.error(`EXIFR does not support ${extension} files`, e);
            return undefined;
        } else {
            log.error(`Failed to parse Exif data for a ${extension} file`, e);
            throw e;
        }
    }
}

function parseExifData(exifData: RawEXIFData): ParsedEXIFData {
    if (!exifData) {
        return null;
    }
    const {
        DateTimeOriginal,
        CreateDate,
        ModifyDate,
        DateCreated,
        ImageHeight,
        ImageWidth,
        ExifImageHeight,
        ExifImageWidth,
        PixelXDimension,
        PixelYDimension,
        MetadataDate,
        ...rest
    } = exifData;
    const parsedExif: ParsedEXIFData = { ...rest };
    if (DateTimeOriginal) {
        parsedExif.DateTimeOriginal = parseEXIFDate(exifData.DateTimeOriginal);
    }
    if (CreateDate) {
        parsedExif.CreateDate = parseEXIFDate(exifData.CreateDate);
    }
    if (ModifyDate) {
        parsedExif.ModifyDate = parseEXIFDate(exifData.ModifyDate);
    }
    if (DateCreated) {
        parsedExif.DateCreated = parseEXIFDate(exifData.DateCreated);
    }
    if (MetadataDate) {
        parsedExif.MetadataDate = parseEXIFDate(exifData.MetadataDate);
    }
    if (exifData.GPSLatitude && exifData.GPSLongitude) {
        const parsedLocation = parseEXIFLocation(
            exifData.GPSLatitude,
            exifData.GPSLatitudeRef,
            exifData.GPSLongitude,
            exifData.GPSLongitudeRef,
        );
        parsedExif.latitude = parsedLocation.latitude;
        parsedExif.longitude = parsedLocation.longitude;
    }
    if (ImageWidth && ImageHeight) {
        if (typeof ImageWidth === "number" && typeof ImageHeight === "number") {
            parsedExif.imageWidth = ImageWidth;
            parsedExif.imageHeight = ImageHeight;
        } else {
            log.warn("Exif: Ignoring non-numeric ImageWidth or ImageHeight");
        }
    } else if (ExifImageWidth && ExifImageHeight) {
        if (
            typeof ExifImageWidth === "number" &&
            typeof ExifImageHeight === "number"
        ) {
            parsedExif.imageWidth = ExifImageWidth;
            parsedExif.imageHeight = ExifImageHeight;
        } else {
            log.warn(
                "Exif: Ignoring non-numeric ExifImageWidth or ExifImageHeight",
            );
        }
    } else if (PixelXDimension && PixelYDimension) {
        if (
            typeof PixelXDimension === "number" &&
            typeof PixelYDimension === "number"
        ) {
            parsedExif.imageWidth = PixelXDimension;
            parsedExif.imageHeight = PixelYDimension;
        } else {
            log.warn(
                "Exif: Ignoring non-numeric PixelXDimension or PixelYDimension",
            );
        }
    }
    return parsedExif;
}

function parseEXIFDate(dateTimeString: string) {
    try {
        if (typeof dateTimeString !== "string" || dateTimeString === "") {
            throw new Error("Invalid date string");
        }

        // Check and parse date in the format YYYYMMDD
        if (dateTimeString.length === 8) {
            const year = Number(dateTimeString.slice(0, 4));
            const month = Number(dateTimeString.slice(4, 6));
            const day = Number(dateTimeString.slice(6, 8));
            if (
                !Number.isNaN(year) &&
                !Number.isNaN(month) &&
                !Number.isNaN(day)
            ) {
                const date = new Date(year, month - 1, day);
                if (!Number.isNaN(+date)) {
                    return date;
                }
            }
        }
        const [year, month, day, hour, minute, second] = dateTimeString
            .match(/\d+/g)
            .map(Number);

        if (
            typeof year === "undefined" ||
            Number.isNaN(year) ||
            typeof month === "undefined" ||
            Number.isNaN(month) ||
            typeof day === "undefined" ||
            Number.isNaN(day)
        ) {
            throw new Error("Invalid date");
        }
        let date: Date;
        if (
            typeof hour === "undefined" ||
            Number.isNaN(hour) ||
            typeof minute === "undefined" ||
            Number.isNaN(minute) ||
            typeof second === "undefined" ||
            Number.isNaN(second)
        ) {
            date = new Date(year, month - 1, day);
        } else {
            date = new Date(year, month - 1, day, hour, minute, second);
        }
        if (Number.isNaN(+date)) {
            throw new Error("Invalid date");
        }
        return date;
    } catch (e) {
        log.error(`Failed to parseEXIFDate ${dateTimeString}`, e);
        return null;
    }
}

export function parseEXIFLocation(
    gpsLatitude: number[],
    gpsLatitudeRef: string,
    gpsLongitude: number[],
    gpsLongitudeRef: string,
) {
    try {
        if (
            !Array.isArray(gpsLatitude) ||
            !Array.isArray(gpsLongitude) ||
            gpsLatitude.length !== 3 ||
            gpsLongitude.length !== 3
        ) {
            throw new Error("Invalid Exif location");
        }
        const latitude = convertDMSToDD(
            gpsLatitude[0],
            gpsLatitude[1],
            gpsLatitude[2],
            gpsLatitudeRef,
        );
        const longitude = convertDMSToDD(
            gpsLongitude[0],
            gpsLongitude[1],
            gpsLongitude[2],
            gpsLongitudeRef,
        );
        return { latitude, longitude };
    } catch (e) {
        const p = {
            gpsLatitude,
            gpsLatitudeRef,
            gpsLongitude,
            gpsLongitudeRef,
        };
        log.error(`Failed to parse Exif location ${JSON.stringify(p)}`, e);
        return { ...NULL_LOCATION };
    }
}

function convertDMSToDD(
    degrees: number,
    minutes: number,
    seconds: number,
    direction: string,
) {
    let dd = degrees + minutes / 60 + seconds / (60 * 60);
    if (direction === "S" || direction === "W") dd *= -1;
    return dd;
}

export function getEXIFLocation(exifData: ParsedEXIFData): Location {
    if (!exifData || (!exifData.latitude && exifData.latitude !== 0)) {
        return { ...NULL_LOCATION };
    }
    return { latitude: exifData.latitude, longitude: exifData.longitude };
}

export function getEXIFTime(exifData: ParsedEXIFData): number {
    if (!exifData) {
        return null;
    }
    const dateTime =
        exifData.DateTimeOriginal ??
        exifData.DateCreated ??
        exifData.CreateDate ??
        exifData.MetadataDate ??
        exifData.ModifyDate;
    if (!dateTime) {
        return null;
    }
    return validateAndGetCreationUnixTimeInMicroSeconds(dateTime);
}
